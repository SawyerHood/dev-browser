mod connection;
mod daemon;
mod skill;

use clap::{CommandFactory, Parser, Subcommand};
use connection::{connect_to_daemon, read_line, send_message};
use daemon::{ensure_daemon, install_daemon_runtime, is_daemon_running};
use serde::Deserialize;
use serde_json::{json, Value};
use skill::install_skill;
use std::error::Error;
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

const CLI_LONG_ABOUT: &str = r###"Dev Browser is a CLI for controlling local or external browsers with JavaScript scripts.
Scripts run in a sandboxed QuickJS runtime (not Node.js). Top-level `await` is
available, along with a preconnected `browser` global and standard `console` output.
A background daemon starts automatically when needed and manages browser instances,
named pages, and CDP connections.

SANDBOX ENVIRONMENT:
  Scripts execute inside a QuickJS WASM sandbox with no arbitrary access to the host system.
  This is NOT Node.js — the following are NOT available:
    - require() / import()     No module loading
    - process                  No process access
    - fs / path / os           No direct filesystem access
    - fetch / WebSocket        No direct network access
    - __dirname / __filename   No path globals

  Available globals:
    browser                    Pre-connected browser handle (see API below)
    console                    log, warn, error, info (routed to CLI output)
    setTimeout / clearTimeout  Basic timers
    snapshot(nameOrId?)        Get a YAML accessibility snapshot for a page
    saveScreenshot(buf, name)  Save a screenshot buffer (async, must be awaited)
    writeFile(name, data)      Write a file to temp dir (async, must be awaited)
    readFile(name)             Read a file from temp dir (async, must be awaited)

  Memory and CPU limits are enforced. Infinite loops will be interrupted.

Primary invocation styles:
  dev-browser <<'EOF'
    const page = await browser.getPage("main");
    await page.goto("https://example.com");
    console.log(await page.title());
  EOF

  dev-browser run script.js
  dev-browser --browser my-project < script.js
  dev-browser --connect http://localhost:9222 <<'EOF'
    const page = await browser.getPage("main");
    await page.goto("https://example.com");
  EOF
  dev-browser --connect <<'EOF'
    const page = await browser.getPage("main");
    console.log(await page.title());
  EOF

Script API available inside every script:
  browser.getPage(nameOrId) Get a page by name (creates if new) or connect to an existing
                            tab by its targetId from listPages().
  browser.newPage()       Create an anonymous page. Anonymous pages are cleaned up after the script exits.
  browser.listPages()       List all tabs: named pages and existing browser tabs.
                            Returns [{id, url, title, name}].
  browser.closePage(name) Close and remove a named page.
  browser.snapshot(nameOrId?) Get a page's YAML accessibility snapshot.
                            Omit nameOrId when one named page or one total page is open.
  await snapshot(nameOrId?) Get the same YAML accessibility snapshot as browser.snapshot().
  await saveScreenshot(buf: Buffer, name: string): Promise<string>
                          Save a screenshot buffer to ~/.dev-browser/tmp/<name>.
                          Returns the full path to the saved file.
                          Example: const path = await saveScreenshot(await page.screenshot(), "home.png");

  await writeFile(name: string, data: string): Promise<string>
                          Write data to ~/.dev-browser/tmp/<name>.
                          Returns the full path to the written file.
                          Example: const path = await writeFile("results.json", JSON.stringify(data));

  await readFile(name: string): Promise<string>
                          Read a file from ~/.dev-browser/tmp/<name>.
                          Returns the file content as a string.
                          Example: const data = JSON.parse(await readFile("results.json"));

  console.log/info(...)   Write output to stdout.
  console.warn/error(...) Write output to stderr.

  All file I/O functions are async and must be awaited.
  All paths are restricted to ~/.dev-browser/tmp/ — no filesystem escape.

Pages returned by `browser.getPage()` and `browser.newPage()` are full Playwright
Page objects — you get the same API (goto, click, fill, locator, evaluate, etc.):
  https://playwright.dev/docs/api/class-page"###;

const CLI_AFTER_LONG_HELP: &str = r####"LLM USAGE GUIDE:
  Write small, focused scripts. Each script should do ONE thing: navigate, click, fill, or check.
  End each script by logging the state you need for the next decision.
  Use descriptive page names like "login", "checkout", or "results" instead of "page1".
  Named pages from browser.getPage("name") persist between script runs, so you usually do not need to re-navigate.
  Inside page.evaluate(...), write plain JavaScript only - no TypeScript syntax in the browser context.

  Quick inspection:
    dev-browser --connect <<'EOF'
    const tabs = await browser.listPages();
    console.log(JSON.stringify(tabs, null, 2));
    EOF

    dev-browser --connect <<'EOF'
    const page = await browser.getPage("TARGET_ID_HERE");
    console.log(JSON.stringify({
      url: page.url(),
      title: await page.title(),
    }, null, 2));
    EOF

  ARIA snapshots for element discovery:
    dev-browser <<'EOF'
    const page = await browser.getPage("main");
    const yaml = await snapshot("main");
    console.log(yaml);
    // Or call Playwright directly:
    // console.log(await page.locator("body").ariaSnapshot());
    // Read the role/name lines to identify the right element.
    // Then interact with it using a locator from that line:
    // await page.getByRole("button", { name: "Continue" }).click();
    // Re-run snapshot("main") after the page changes to get fresh structure.
    EOF

  Screenshots for visual state:
    dev-browser <<'EOF'
    const page = await browser.getPage("main");
    const buf = await page.screenshot();
    const path = await saveScreenshot(buf, "debug.png");
    console.log(path);
    EOF

  Waiting patterns:
    dev-browser <<'EOF'
    const page = await browser.getPage("search-results");
    await page.waitForSelector(".results");
    await page.waitForURL("**/success");
    console.log(JSON.stringify({
      url: page.url(),
      title: await page.title(),
    }, null, 2));
    EOF

  Error recovery:
    If a script fails, the page usually stays where it stopped.
    Reconnect to the same page name, take a screenshot, and log the URL/title:
    dev-browser <<'EOF'
    const page = await browser.getPage("checkout");
    const path = await saveScreenshot(await page.screenshot(), "debug.png");
    console.log(JSON.stringify({
      screenshot: path,
      url: page.url(),
      title: await page.title(),
    }, null, 2));
    EOF

  Common Playwright Page methods:
    page.goto(url)                         Navigate to a URL
    page.title()                           Get the current page title
    page.url()                             Get the current URL
    browser.snapshot(nameOrId?)            Get a YAML accessibility snapshot for a page
    snapshot(nameOrId?)                    Same as browser.snapshot(...)
    page.locator("body").ariaSnapshot()    Direct Playwright accessibility snapshot
    page.getByRole(role, { name })         Target elements discovered from the snapshot
    page.textContent(selector)             Get the text content of an element
    page.innerHTML(selector)               Get the inner HTML of an element
    page.fill(selector, value)             Fill an input field
    page.click(selector)                   Click an element
    page.type(selector, text)              Type text character by character
    page.press(selector, key)              Press a key such as Enter or Tab
    page.waitForSelector(selector)         Wait for an element to appear
    page.waitForURL(url)                   Wait for navigation to a URL
    page.screenshot()                      Capture a screenshot buffer; save it with saveScreenshot(...)
    page.$$eval(selector, fn)              Run a function on all matching elements
    page.$eval(selector, fn)               Run a function on the first matching element
    page.evaluate(fn)                      Run JavaScript in the page context (plain JS only)
    page.locator(selector)                 Create a locator for chained actions

  Connecting to a running Chrome instance:
    Auto-discover Chrome with debugging enabled:
      dev-browser --connect <<'EOF'
        const page = await browser.getPage("main");
        console.log(await page.title());
      EOF

    Connect to a specific CDP endpoint:
      dev-browser --connect http://localhost:9222 <<'EOF'
        const page = await browser.getPage("main");
        console.log(await page.title());
      EOF

    To launch Chrome with debugging enabled:
      /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222

    Or visit chrome://inspect/#remote-debugging to configure.

  Tips:
    - Use console.log(JSON.stringify(...)) for structured output.
    - Prefer snapshot() for structure; use screenshots when visual layout or styling matters.
    - Keep page names stable across scripts so you can resume work after failures.
    - Each --browser name maps to a separate daemon-managed browser instance.
    - Use --connect to attach to an existing browser; omit the URL to auto-discover Chrome with debugging enabled.
    - Use short timeouts (--timeout 10) so scripts fail fast instead of hanging on missing elements.
    - Add --headless for unattended automation; omit it when you want to watch the browser window."####;

const DEFAULT_SCRIPT_TIMEOUT_SECS: u32 = 30;

#[derive(Parser)]
#[command(name = "dev-browser")]
#[command(about = "Control browsers with JavaScript automation scripts")]
#[command(long_about = CLI_LONG_ABOUT)]
#[command(after_long_help = CLI_AFTER_LONG_HELP)]
struct Cli {
    #[arg(
        long,
        default_value = "default",
        value_name = "NAME",
        help = "Use a named daemon-managed browser instance",
        long_help = "Select the named browser instance to run against.\n\nThe daemon keeps separate browser state for each name. Named pages created with `browser.getPage(\"name\")` persist within that browser between script runs.\n\nDefaults to `default`."
    )]
    browser: String,

    #[arg(
        long,
        num_args = 0..=1,
        default_missing_value = "auto",
        value_name = "URL",
        help = "Connect to a running Chrome instance",
        long_help = "Connect to a running Chrome instance.\n\nWithout a URL: auto-discovers Chrome with debugging enabled.\nWorks with Chrome's built-in remote debugging\n(chrome://inspect/#remote-debugging) and classic\n--remote-debugging-port mode.\n\nWith a URL: connects to the specified CDP endpoint.\nAccepts HTTP or WebSocket CDP endpoints such as `http://localhost:9222` or `ws://host:9222/devtools/browser/...`.\n\nTo launch Chrome with debugging:\n  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222\n\nOr visit chrome://inspect/#remote-debugging to configure."
    )]
    connect: Option<String>,

    #[arg(
        long,
        help = "Launch daemon-managed Chromium without a visible window",
        long_help = "Launch or relaunch daemon-managed Chromium in headless mode.\n\nThis only affects daemon-launched browsers. It has no effect when `--connect` attaches to an already-running external browser."
    )]
    headless: bool,

    #[arg(
        long,
        default_value_t = DEFAULT_SCRIPT_TIMEOUT_SECS,
        value_name = "SECONDS",
        value_parser = clap::value_parser!(u32).range(1..),
        help = "Maximum script execution time in seconds",
        long_help = "Maximum script execution time in seconds.\n\nIf the script exceeds this limit, the daemon terminates it and returns an error.\n\nDefaults to 30 seconds."
    )]
    timeout: u32,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    #[command(
        about = "Run a script file against the browser",
        long_about = "Run a script file against the browser.\n\nThe file is executed the same way as stdin input: as top-level JavaScript with `await`, `browser`, and `console` available.\n\nUse top-level flags before `run`, for example `dev-browser --browser my-project run script.js`."
    )]
    Run {
        #[arg(
            value_name = "FILE",
            help = "Path to a JavaScript file to execute",
            long_help = "Path to the JavaScript file to execute.\n\nThis is equivalent to `dev-browser < script.js`, but can be easier to script or combine with shell tooling."
        )]
        file: String,
    },
    #[command(
        about = "Install Playwright browsers (Chromium)",
        long_about = "Install Playwright browsers (Chromium).\n\nDownloads the Chromium build used for daemon-managed browser instances."
    )]
    Install,
    #[command(
        about = "Install the dev-browser skill into agent skill directories",
        long_about = "Install the embedded dev-browser skill into selected agent skill directories.\n\nLaunches an interactive multi-select prompt for the supported install targets."
    )]
    InstallSkill,
    #[command(
        about = "List all managed browser instances",
        long_about = "List all managed browser instances.\n\nShows the browser name, whether it is daemon-launched or externally connected, its status, and any named pages currently registered."
    )]
    Browsers,
    #[command(
        about = "Show daemon status",
        long_about = "Show daemon status.\n\nPrints daemon process details, socket path, uptime, and the current set of managed browsers."
    )]
    Status,
    #[command(
        about = "Stop the daemon and all browsers",
        long_about = "Stop the daemon and all browsers.\n\nThis stops the background daemon process and closes every browser instance it currently manages."
    )]
    Stop,
}

#[derive(Debug, Deserialize)]
struct BrowserSummary {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    pages: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StatusSummary {
    pid: i32,
    #[serde(rename = "uptimeMs")]
    uptime_ms: u64,
    #[serde(rename = "browserCount")]
    browser_count: usize,
    #[serde(rename = "socketPath")]
    socket_path: String,
    browsers: Vec<BrowserSummary>,
}

enum ResultMode {
    None,
    Json,
    Browsers,
    Status,
}

fn main() {
    let exit_code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    };

    process::exit(exit_code);
}

fn run() -> Result<i32, Box<dyn Error>> {
    let cli = Cli::parse();

    match &cli.command {
        Some(Command::Run { file }) => {
            let script = fs::read_to_string(file)?;
            run_script(&cli, script)
        }
        Some(Command::Browsers) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("browsers"),
                    "type": "browsers",
                }),
                ResultMode::Browsers,
            )
        }
        Some(Command::Install) => {
            install_daemon_runtime()?;
            Ok(0)
        }
        Some(Command::InstallSkill) => {
            install_skill()?;
            Ok(0)
        }
        Some(Command::Status) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("status"),
                    "type": "status",
                }),
                ResultMode::Status,
            )
        }
        Some(Command::Stop) => {
            if !is_daemon_running() {
                println!("Daemon is not running.");
                return Ok(0);
            }

            let exit_code = send_request(
                json!({
                    "id": request_id("stop"),
                    "type": "stop",
                }),
                ResultMode::None,
            )?;

            if exit_code == 0 {
                println!("Daemon stopped.");
            }

            Ok(exit_code)
        }
        None => {
            if stdin_is_tty() {
                let mut command = Cli::command();
                command.print_help()?;
                println!();
                return Ok(2);
            }

            let script = read_script_from_stdin()?;
            run_script(&cli, script)
        }
    }
}

fn run_script(cli: &Cli, script: String) -> Result<i32, Box<dyn Error>> {
    ensure_daemon()?;

    let timeout_ms = u64::from(cli.timeout)
        .checked_mul(1_000)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Timeout value is too large"))?;

    let mut request = json!({
        "id": request_id("execute"),
        "type": "execute",
        "browser": cli.browser,
        "script": script,
        "timeoutMs": timeout_ms,
    });

    if cli.headless {
        request["headless"] = Value::Bool(true);
    }

    if let Some(endpoint) = &cli.connect {
        request["connect"] = Value::String(endpoint.clone());
    }

    send_request(request, ResultMode::Json)
}

fn send_request(message: Value, result_mode: ResultMode) -> Result<i32, Box<dyn Error>> {
    let mut stream = connect_to_daemon()?;
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);

    send_message(&mut stream, &message)?;
    stream_responses(&mut reader, result_mode)
}

fn stream_responses(
    reader: &mut BufReader<UnixStream>,
    result_mode: ResultMode,
) -> Result<i32, Box<dyn Error>> {
    loop {
        let line = read_line(reader)?;
        let message: Value = serde_json::from_str(line.trim_end())?;

        match message.get("type").and_then(Value::as_str) {
            Some("stdout") => {
                if let Some(data) = message.get("data").and_then(Value::as_str) {
                    print!("{data}");
                    io::stdout().flush()?;
                }
            }
            Some("stderr") => {
                if let Some(data) = message.get("data").and_then(Value::as_str) {
                    eprint!("{data}");
                    io::stderr().flush()?;
                }
            }
            Some("result") => {
                if let Some(data) = message.get("data") {
                    render_result(data, &result_mode)?;
                }
            }
            Some("complete") => return Ok(0),
            Some("error") => {
                let error_message = message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown daemon error");
                eprintln!("{error_message}");
                return Ok(1);
            }
            _ => {}
        }
    }
}

fn render_result(data: &Value, result_mode: &ResultMode) -> Result<(), Box<dyn Error>> {
    match result_mode {
        ResultMode::None => {}
        ResultMode::Json => {
            if data.is_null() {
                return Ok(());
            }

            if let Some(text) = data.as_str() {
                println!("{text}");
            } else {
                println!("{}", serde_json::to_string_pretty(data)?);
            }
        }
        ResultMode::Browsers => print_browsers(data)?,
        ResultMode::Status => print_status(data)?,
    }

    Ok(())
}

fn print_browsers(data: &Value) -> Result<(), Box<dyn Error>> {
    let browsers: Vec<BrowserSummary> = serde_json::from_value(data.clone())?;
    if browsers.is_empty() {
        println!("No browsers.");
        return Ok(());
    }

    let page_values: Vec<String> = browsers
        .iter()
        .map(|browser| {
            if browser.pages.is_empty() {
                "-".to_string()
            } else {
                browser.pages.join(", ")
            }
        })
        .collect();

    let name_width = browsers
        .iter()
        .map(|browser| browser.name.len())
        .max()
        .unwrap_or(4)
        .max("NAME".len());
    let type_width = browsers
        .iter()
        .map(|browser| browser.kind.len())
        .max()
        .unwrap_or(4)
        .max("TYPE".len());
    let status_width = browsers
        .iter()
        .map(|browser| browser.status.len())
        .max()
        .unwrap_or(6)
        .max("STATUS".len());

    println!(
        "{:<name_width$}  {:<type_width$}  {:<status_width$}  PAGES",
        "NAME", "TYPE", "STATUS"
    );

    for (browser, pages) in browsers.iter().zip(page_values.iter()) {
        println!(
            "{:<name_width$}  {:<type_width$}  {:<status_width$}  {}",
            browser.name, browser.kind, browser.status, pages
        );
    }

    Ok(())
}

fn print_status(data: &Value) -> Result<(), Box<dyn Error>> {
    let status: StatusSummary = serde_json::from_value(data.clone())?;

    println!("PID: {}", status.pid);
    println!("Uptime: {}", format_duration_ms(status.uptime_ms));
    println!("Browsers: {}", status.browser_count);
    println!("Socket: {}", status.socket_path);

    if !status.browsers.is_empty() {
        let managed = status
            .browsers
            .iter()
            .map(|browser| format!("{} ({}, {})", browser.name, browser.kind, browser.status))
            .collect::<Vec<_>>()
            .join(", ");
        println!("Managed: {managed}");
    }

    Ok(())
}

fn read_script_from_stdin() -> io::Result<String> {
    let mut script = String::new();
    io::stdin().read_to_string(&mut script)?;
    Ok(script)
}

fn stdin_is_tty() -> bool {
    unsafe { libc::isatty(libc::STDIN_FILENO) == 1 }
}

fn request_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{now}-{}", process::id())
}

fn format_duration_ms(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        return format!("{duration_ms}ms");
    }

    if duration_ms < 60_000 {
        return format!("{:.1}s", duration_ms as f64 / 1_000.0);
    }

    let total_seconds = duration_ms / 1_000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}m {seconds}s")
}

mod connection;
mod daemon;
mod skill;

use clap::{CommandFactory, Parser, Subcommand};
use connection::{connect_to_daemon, read_line, send_message};
use daemon::{
    current_daemon_pid, ensure_daemon, install_daemon_runtime, is_daemon_running,
    wait_for_daemon_exit,
};
use serde::Deserialize;
use serde_json::{json, Value};
use skill::install_skill;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    saveScreenshot(buf, name)  Save a screenshot buffer (async, must be awaited)
    writeFile(name, data)      Write a file to temp dir (async, must be awaited)
    readFile(name)             Read a file from temp dir (async, must be awaited)

  Memory and CPU limits are enforced. Infinite loops will be interrupted.

Structured / agent-facing surfaces:
  dev-browser capabilities --json    Machine-readable contract: version, commands,
                                      exit-code dictionary, environment variables.
  dev-browser robot-docs             Print the full agent usage guide to stdout,
                                      unaffected by --help truncation or -h's brevity.
  dev-browser status --json          Daemon status as JSON instead of a table.
  dev-browser browsers --json        Managed browser list as JSON instead of a table.
  dev-browser --version / -V         Print the installed CLI version and exit.
  dev-browser stop --browser <NAME>  Stop one named browser instead of the whole daemon.

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

const CLI_AFTER_LONG_HELP: &str = include_str!("../llm-guide.txt");

const DEFAULT_SCRIPT_TIMEOUT_SECS: u32 = 30;

#[derive(Parser)]
#[command(name = "dev-browser")]
#[command(version)]
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
        value_parser = parse_connect_value,
        help = "Connect to a running Chrome instance",
        long_help = "Connect to a running Chrome instance.\n\nWithout a URL: auto-discovers Chrome with debugging enabled.\nWorks with Chrome's built-in remote debugging\n(chrome://inspect/#remote-debugging) and classic\n--remote-debugging-port mode.\n\nWith a URL: connects to the specified CDP endpoint.\nAccepts HTTP or WebSocket CDP endpoints such as `http://localhost:9222` or `ws://host:9222/devtools/browser/...`.\n\nTo launch Chrome with debugging, use a command such as:\n  chrome.exe --remote-debugging-port=9222\n  google-chrome --remote-debugging-port=9222\n\nOr visit chrome://inspect/#remote-debugging to configure.\n\nNOTE: `--connect` greedily takes the next word as its value, which can swallow\na following subcommand name (e.g. `--connect run` is parsed as connecting to\na CDP URL literally named \"run\"). Use `--connect=auto run script.js` (with an\n`=`) when you want to auto-connect and still invoke a subcommand."
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
        help = "Ignore HTTPS certificate errors for daemon-managed Chromium",
        long_help = "Launch or relaunch daemon-managed Chromium with HTTPS certificate errors ignored.\n\nThis is useful for self-signed certificates in local or staging environments. The setting applies per managed browser session until the daemon restarts or the setting changes and triggers a relaunch.\n\nThis only affects daemon-launched browsers. It has no effect when `--connect` attaches to an already-running external browser."
    )]
    ignore_https_errors: bool,

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
        long_about = "Install the embedded dev-browser skill into agent skill directories.\n\nBy default, launches an interactive multi-select prompt for the supported install targets when a TTY is available.\n\nIn non-interactive environments, installs to all supported skill directories, including Codex, so upgrades replace stale skill copies.\n\nUse `--claude`, `--agents`, and/or `--codex` to skip prompting and install to specific targets."
    )]
    InstallSkill {
        #[arg(
            long,
            help = "Install the skill into ~/.claude/skills without prompting"
        )]
        claude: bool,
        #[arg(
            long,
            help = "Install the skill into ~/.agents/skills without prompting"
        )]
        agents: bool,
        #[arg(
            long,
            help = "Install the skill into ~/.codex/skills without prompting"
        )]
        codex: bool,
    },
    #[command(
        about = "List all managed browser instances",
        long_about = "List all managed browser instances.\n\nShows the browser name, whether it is daemon-launched or externally connected, its status, and any named pages currently registered."
    )]
    Browsers {
        #[arg(
            long,
            help = "Emit machine-readable JSON instead of a table",
            long_help = "Emit the browser list as JSON instead of a hand-formatted table.\n\nSchema: an array of {name, type, status, pages: [string]} objects."
        )]
        json: bool,
    },
    #[command(
        about = "Show daemon status",
        long_about = "Show daemon status.\n\nPrints daemon process details, socket path, uptime, and the current set of managed browsers."
    )]
    Status {
        #[arg(
            long,
            help = "Emit machine-readable JSON instead of a table",
            long_help = "Emit daemon status as JSON instead of formatted text.\n\nSchema: {pid, uptimeMs, browserCount, socketPath, browsers: [...]}."
        )]
        json: bool,
    },
    #[command(
        about = "Stop the daemon and all browsers",
        long_about = "Stop the daemon and all browsers, or a single named browser.\n\nWithout --browser, this stops the background daemon process and closes every browser instance it currently manages. With --browser <NAME>, only that browser instance is closed; the daemon and any other managed browsers keep running."
    )]
    Stop {
        #[arg(
            long,
            value_name = "NAME",
            help = "Stop only the named browser instance instead of the whole daemon",
            long_help = "Stop only the named browser instance instead of the whole daemon.\n\nThe daemon and any other managed browsers keep running. Use this instead of a bare `stop` when other agents or sessions share the daemon.\n\nWithout this flag, `stop` shuts down the daemon and closes every managed browser."
        )]
        browser: Option<String>,
    },
    #[command(
        about = "Print the CLI's machine-readable capabilities document",
        long_about = "Print the CLI's machine-readable capabilities document: version, command list, exit-code dictionary, and environment variables.\n\nIntended for agents to introspect the tool's contract instead of parsing --help."
    )]
    Capabilities {
        #[arg(
            long,
            help = "Emit the full capabilities document as JSON (recommended for agents)",
            long_help = "Emit the full capabilities document as JSON instead of a human-readable summary.\n\nThis is the canonical form for agents: `dev-browser capabilities --json`."
        )]
        json: bool,
    },
    #[command(
        about = "Print the full agent usage guide (also shown after --help)",
        long_about = "Print the full agent usage guide in-tool, with no need to scroll past --help.\n\nThis is the same content shown after `dev-browser --help`, but `-h` and truncated `--help` output (e.g. piped through `head`) don't reliably surface it. `robot-docs` always prints the whole guide to stdout regardless of terminal size or truncation."
    )]
    RobotDocs,
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

/// Documented exit-code dictionary. Exit 2 is reserved for clap's own usage
/// errors (bad flags) and is also used by our own "printed help instead of
/// running a script" case; it is intentionally not constructed via this enum
/// at every call site, but it IS listed here so `capabilities --json` stays
/// the single source of truth for the whole dictionary.
#[derive(Clone, Copy)]
#[repr(i32)]
enum ExitCode {
    Success = 0,
    GenericError = 1,
    Usage = 2,
    ToolEnvironment = 3,
    Upstream = 4,
}

impl ExitCode {
    const fn code(self) -> i32 {
        self as i32
    }

    const fn label(self) -> &'static str {
        match self {
            ExitCode::Success => "success",
            ExitCode::GenericError => "generic-error",
            ExitCode::Usage => "usage-error",
            ExitCode::ToolEnvironment => "tool-environment-error",
            ExitCode::Upstream => "upstream-failure",
        }
    }

    const fn description(self) -> &'static str {
        match self {
            ExitCode::Success => "The command completed successfully.",
            ExitCode::GenericError => "An unclassified CLI-side error occurred (I/O, connection, or parsing failure). See the printed `Error:` line for detail.",
            ExitCode::Usage => "Invalid arguments/flags (raised by clap), or a bare invocation with no piped script on an interactive stdin (help was printed instead of running a script).",
            ExitCode::ToolEnvironment => "A local environment problem: missing runtime dependency, `dev-browser install` not run yet, Chromium failed to launch, or the daemon could not start/stop.",
            ExitCode::Upstream => "The daemon reported a failure from the script, browser, or CDP connection itself (not a CLI-side problem).",
        }
    }

    fn dictionary() -> [(i32, &'static str, &'static str); 5] {
        [
            (
                ExitCode::Success.code(),
                ExitCode::Success.label(),
                ExitCode::Success.description(),
            ),
            (
                ExitCode::GenericError.code(),
                ExitCode::GenericError.label(),
                ExitCode::GenericError.description(),
            ),
            (
                ExitCode::Usage.code(),
                ExitCode::Usage.label(),
                ExitCode::Usage.description(),
            ),
            (
                ExitCode::ToolEnvironment.code(),
                ExitCode::ToolEnvironment.label(),
                ExitCode::ToolEnvironment.description(),
            ),
            (
                ExitCode::Upstream.code(),
                ExitCode::Upstream.label(),
                ExitCode::Upstream.description(),
            ),
        ]
    }
}

fn main() {
    let exit_code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error}");
            classify_error_exit_code(&*error)
        }
    };

    process::exit(exit_code);
}

/// Chooses the exit code for a top-level error. Only one class is currently
/// distinguished from the generic bucket: errors the daemon-management code
/// tagged as environment problems (missing runtime, daemon wouldn't
/// start/stop, Chromium wouldn't launch). Everything else stays the
/// pre-existing generic-error code so this stays a small, documented
/// classifier rather than a full error-type hierarchy.
fn classify_error_exit_code(error: &(dyn Error + 'static)) -> i32 {
    if error
        .downcast_ref::<daemon::ToolEnvironmentError>()
        .is_some()
    {
        ExitCode::ToolEnvironment.code()
    } else {
        ExitCode::GenericError.code()
    }
}

fn run() -> Result<i32, Box<dyn Error>> {
    let cli = Cli::parse();

    match &cli.command {
        Some(Command::Run { file }) => {
            let script = fs::read_to_string(file)?;
            run_script(&cli, script)
        }
        Some(Command::Browsers { json }) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("browsers"),
                    "type": "browsers",
                }),
                if *json {
                    ResultMode::Json
                } else {
                    ResultMode::Browsers
                },
            )
        }
        Some(Command::Install) => {
            install_daemon_runtime()?;
            Ok(0)
        }
        Some(Command::InstallSkill {
            claude,
            agents,
            codex,
        }) => {
            install_skill(*claude, *agents, *codex)?;
            Ok(0)
        }
        Some(Command::Status { json }) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("status"),
                    "type": "status",
                }),
                if *json {
                    ResultMode::Json
                } else {
                    ResultMode::Status
                },
            )
        }
        Some(Command::Stop { browser }) => {
            if !is_daemon_running() {
                eprintln!("Daemon is not running.");
                return Ok(0);
            }

            if let Some(browser_name) = browser {
                let exit_code = send_request(
                    json!({
                        "id": request_id("browser-stop"),
                        "type": "browser-stop",
                        "browser": browser_name,
                    }),
                    ResultMode::None,
                )?;

                if exit_code == 0 {
                    eprintln!("Stopped browser '{browser_name}'. The daemon and other browsers keep running.");
                }

                return Ok(exit_code);
            }

            let daemon_pid = current_daemon_pid();

            let exit_code = send_request(
                json!({
                    "id": request_id("stop"),
                    "type": "stop",
                }),
                ResultMode::None,
            )?;

            if exit_code == 0 {
                if let Some(pid) = daemon_pid {
                    wait_for_daemon_exit(pid, Duration::from_secs(10))?;
                }
                eprintln!("Stopped the daemon and all managed browsers.");
            }

            Ok(exit_code)
        }
        Some(Command::Capabilities { json }) => {
            print_capabilities(*json)?;
            Ok(0)
        }
        Some(Command::RobotDocs) => {
            print!("{CLI_AFTER_LONG_HELP}");
            Ok(0)
        }
        None => {
            if stdin_is_tty() {
                let mut command = Cli::command();
                command.print_help()?;
                println!();
                return Ok(ExitCode::Usage.code());
            }

            let script = read_script_from_stdin()?;
            run_script(&cli, script)
        }
    }
}

fn known_subcommand_names() -> &'static [&'static str] {
    &[
        "run",
        "install",
        "install-skill",
        "browsers",
        "status",
        "stop",
        "capabilities",
        "robot-docs",
    ]
}

/// Validates `--connect`'s optional value. `--connect` uses `num_args = 0..=1`
/// so it greedily tries to consume the next bare token as its URL, including
/// a following subcommand name (`dev-browser --connect run` parses "run" as
/// the CDP URL instead of routing to the `run` subcommand). Rather than
/// silently doing the wrong thing, reject known-subcommand-shaped values with
/// an error that names the exact fix.
fn parse_connect_value(raw: &str) -> Result<String, String> {
    if raw != "auto" && known_subcommand_names().contains(&raw) {
        return Err(format!(
            "'{raw}' looks like a dev-browser subcommand, not a CDP URL. `--connect` greedily takes the next word as its value. Use `--connect=auto {raw}` (with an `=`) to auto-connect and still invoke the `{raw}` subcommand, or `--connect=<url>` to specify a CDP endpoint explicitly."
        ));
    }

    Ok(raw.to_string())
}

fn capabilities_document() -> Value {
    let exit_codes: Vec<Value> = ExitCode::dictionary()
        .into_iter()
        .map(|(code, name, description)| {
            json!({ "code": code, "name": name, "description": description })
        })
        .collect();

    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "contract_version": 1,
        "commands": [
            { "name": "run", "about": "Run a script file against the browser" },
            { "name": "install", "about": "Install Playwright browsers (Chromium) and verify Chromium actually launches" },
            { "name": "install-skill", "about": "Install the dev-browser skill into agent skill directories" },
            { "name": "browsers", "about": "List all managed browser instances", "json_flag": true },
            { "name": "status", "about": "Show daemon status", "json_flag": true },
            { "name": "stop", "about": "Stop the daemon and all browsers, or one named browser with --browser <NAME>" },
            { "name": "capabilities", "about": "Print this machine-readable capabilities document", "json_flag": true },
            { "name": "robot-docs", "about": "Print the full agent usage guide to stdout" },
        ],
        "exit_codes": exit_codes,
        "env_vars": [
            {
                "name": "DEV_BROWSER_DAEMON",
                "description": "Override the daemon entrypoint (.js/.mjs/.cjs/.ts file, or a native executable) instead of the CLI's embedded daemon bundle."
            }
        ],
        "flags": {
            "--json": "Available on `status`, `browsers`, and `capabilities` for machine-readable output.",
            "--connect": "Optional-value flag: bare `--connect` auto-discovers Chrome; `--connect <url>` or `--connect=<url>` attaches to a specific CDP endpoint. Use `--connect=auto` (with `=`) before a subcommand name to avoid the value swallowing it.",
            "--timeout": "Maximum script execution time in seconds (default 30).",
            "--version / -V": "Print the installed CLI version and exit."
        }
    })
}

fn print_capabilities(json_output: bool) -> Result<(), Box<dyn Error>> {
    let document = capabilities_document();

    if json_output {
        println!("{}", serde_json::to_string_pretty(&document)?);
        return Ok(());
    }

    println!(
        "dev-browser {}",
        document["version"].as_str().unwrap_or("unknown")
    );
    println!("contract_version: {}", document["contract_version"]);
    println!();
    println!("Commands:");
    if let Some(commands) = document["commands"].as_array() {
        for command in commands {
            let name = command["name"].as_str().unwrap_or("?");
            let about = command["about"].as_str().unwrap_or("");
            println!("  {name:<16} {about}");
        }
    }
    println!();
    println!("Exit codes:");
    if let Some(codes) = document["exit_codes"].as_array() {
        for entry in codes {
            let code = entry["code"].as_i64().unwrap_or(-1);
            let name = entry["name"].as_str().unwrap_or("?");
            println!("  {code}  {name}");
        }
    }
    println!();
    println!("Run `dev-browser capabilities --json` for the full machine-readable document.");
    Ok(())
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

    if cli.ignore_https_errors {
        request["ignoreHTTPSErrors"] = Value::Bool(true);
    }

    if let Some(endpoint) = &cli.connect {
        request["connect"] = Value::String(endpoint.clone());
    }

    send_request(request, ResultMode::Json)
}

fn send_request(message: Value, result_mode: ResultMode) -> Result<i32, Box<dyn Error>> {
    let mut stream = connect_to_daemon()?;
    send_message(&mut stream, &message)?;
    let mut reader = BufReader::new(stream);
    stream_responses(&mut reader, result_mode)
}

fn stream_responses<R: BufRead>(
    reader: &mut R,
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
                return Ok(ExitCode::Upstream.code());
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
    io::stdin().is_terminal()
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    // --- P0-4: --version -------------------------------------------------

    #[test]
    fn version_flag_is_recognized_by_clap() {
        let result = Cli::try_parse_from(["dev-browser", "--version"]);
        // `Cli` (the Ok type) doesn't derive Debug, so `.expect_err()`/
        // `.unwrap_err()` can't be used directly (both require T: Debug for
        // the would-be panic message). Route through `.err()` instead.
        let err = result.err().expect("--version should short-circuit parsing");
        assert_eq!(err.kind(), ErrorKind::DisplayVersion);
    }

    #[test]
    fn short_version_flag_is_recognized_by_clap() {
        let result = Cli::try_parse_from(["dev-browser", "-V"]);
        let err = result.err().expect("-V should short-circuit parsing");
        assert_eq!(err.kind(), ErrorKind::DisplayVersion);
    }

    // --- P0-3: --json on status/browsers ----------------------------------

    #[test]
    fn status_json_flag_parses() {
        let cli = Cli::try_parse_from(["dev-browser", "status", "--json"]).unwrap();
        match cli.command {
            Some(Command::Status { json }) => assert!(json),
            _ => panic!("expected Status command"),
        }
    }

    #[test]
    fn status_without_json_flag_defaults_false() {
        let cli = Cli::try_parse_from(["dev-browser", "status"]).unwrap();
        match cli.command {
            Some(Command::Status { json }) => assert!(!json),
            _ => panic!("expected Status command"),
        }
    }

    #[test]
    fn browsers_json_flag_parses() {
        let cli = Cli::try_parse_from(["dev-browser", "browsers", "--json"]).unwrap();
        match cli.command {
            Some(Command::Browsers { json }) => assert!(json),
            _ => panic!("expected Browsers command"),
        }
    }

    #[test]
    fn browsers_without_json_flag_defaults_false() {
        let cli = Cli::try_parse_from(["dev-browser", "browsers"]).unwrap();
        match cli.command {
            Some(Command::Browsers { json }) => assert!(!json),
            _ => panic!("expected Browsers command"),
        }
    }

    // --- P0-2: stop --browser <name> --------------------------------------

    #[test]
    fn stop_without_browser_flag_targets_whole_daemon() {
        let cli = Cli::try_parse_from(["dev-browser", "stop"]).unwrap();
        match cli.command {
            Some(Command::Stop { browser }) => assert!(browser.is_none()),
            _ => panic!("expected Stop command"),
        }
    }

    #[test]
    fn stop_with_browser_flag_targets_named_instance() {
        let cli = Cli::try_parse_from(["dev-browser", "stop", "--browser", "myproj"]).unwrap();
        match cli.command {
            Some(Command::Stop { browser }) => assert_eq!(browser.as_deref(), Some("myproj")),
            _ => panic!("expected Stop command"),
        }
    }

    // --- P0-4: capabilities --json -----------------------------------------

    #[test]
    fn capabilities_subcommand_parses_with_and_without_json() {
        let cli = Cli::try_parse_from(["dev-browser", "capabilities"]).unwrap();
        match cli.command {
            Some(Command::Capabilities { json }) => assert!(!json),
            _ => panic!("expected Capabilities command"),
        }

        let cli = Cli::try_parse_from(["dev-browser", "capabilities", "--json"]).unwrap();
        match cli.command {
            Some(Command::Capabilities { json }) => assert!(json),
            _ => panic!("expected Capabilities command"),
        }
    }

    #[test]
    fn capabilities_document_lists_all_known_commands() {
        let document = capabilities_document();
        assert_eq!(document["version"].as_str(), Some(env!("CARGO_PKG_VERSION")));

        let commands: Vec<&str> = document["commands"]
            .as_array()
            .expect("commands should be an array")
            .iter()
            .map(|entry| entry["name"].as_str().expect("command name"))
            .collect();

        for expected in known_subcommand_names() {
            assert!(
                commands.contains(expected),
                "capabilities document is missing command '{expected}'"
            );
        }
    }

    #[test]
    fn capabilities_document_exit_code_dictionary_is_0_through_4() {
        let document = capabilities_document();
        let codes: Vec<i64> = document["exit_codes"]
            .as_array()
            .expect("exit_codes should be an array")
            .iter()
            .map(|entry| entry["code"].as_i64().expect("exit code"))
            .collect();

        assert_eq!(codes, vec![0, 1, 2, 3, 4]);
    }

    // --- P3-2: --connect must not silently swallow a subcommand -----------

    #[test]
    fn connect_rejects_subcommand_name_as_url() {
        // This is the literal reported repro (CLI-09 / P3-2): `dev-browser
        // --connect run` with no further tokens used to silently succeed
        // with connect="run", which the daemon later rejected as "Invalid
        // URL" — a confusing failure two layers away from the real mistake.
        // With a trailing file argument (`--connect run script.js`), clap's
        // tokenizer resolves the ambiguity structurally (treating "run" as
        // --connect's value up front) before any value_parser ever runs, so
        // "script.js" is left over and clap reports its own native
        // "unrecognized subcommand" error instead — that path is unchanged
        // by this fix and is covered informally by the module docs, not a
        // separate test.
        let result = Cli::try_parse_from(["dev-browser", "--connect", "run"]);
        let err = result
            .err()
            .expect("`--connect run` should be rejected, not silently swallowed");
        let message = err.to_string();
        assert!(
            message.contains("looks like a dev-browser subcommand"),
            "unexpected error message: {message}"
        );
    }

    #[test]
    fn connect_accepts_a_real_url() {
        let cli =
            Cli::try_parse_from(["dev-browser", "--connect", "http://localhost:9222"]).unwrap();
        assert_eq!(cli.connect.as_deref(), Some("http://localhost:9222"));
    }

    #[test]
    fn connect_accepts_bare_form_as_auto() {
        let cli = Cli::try_parse_from(["dev-browser", "--connect"]).unwrap();
        assert_eq!(cli.connect.as_deref(), Some("auto"));
    }

    #[test]
    fn connect_with_explicit_equals_still_routes_to_subcommand() {
        // The documented escape hatch: `--connect=auto` (with `=`) lets a
        // following token be treated as the subcommand instead of being
        // swallowed as --connect's value.
        let cli =
            Cli::try_parse_from(["dev-browser", "--connect=auto", "run", "script.js"]).unwrap();
        assert_eq!(cli.connect.as_deref(), Some("auto"));
        match cli.command {
            Some(Command::Run { file }) => assert_eq!(file, "script.js"),
            _ => panic!("expected Run command"),
        }
    }

    // --- P1-1 partial: robot-docs -------------------------------------------

    #[test]
    fn robot_docs_subcommand_parses() {
        let cli = Cli::try_parse_from(["dev-browser", "robot-docs"]).unwrap();
        assert!(matches!(cli.command, Some(Command::RobotDocs)));
    }

    #[test]
    fn connect_rejects_robot_docs_subcommand_name_as_url() {
        let result = Cli::try_parse_from(["dev-browser", "--connect", "robot-docs"]);
        let err = result
            .err()
            .expect("`--connect robot-docs` should be rejected");
        assert!(err.to_string().contains("looks like a dev-browser subcommand"));
    }

    // --- classify_error_exit_code -------------------------------------------

    #[test]
    fn classify_error_exit_code_flags_tool_environment_errors() {
        let error: Box<dyn Error> =
            Box::new(daemon::ToolEnvironmentError("boom".to_string()));
        assert_eq!(classify_error_exit_code(&*error), ExitCode::ToolEnvironment.code());
    }

    #[test]
    fn classify_error_exit_code_defaults_to_generic() {
        let error: Box<dyn Error> = "boom".into();
        assert_eq!(classify_error_exit_code(&*error), ExitCode::GenericError.code());
    }
}

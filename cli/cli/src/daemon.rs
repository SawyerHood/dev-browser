use crate::connection::connect_to_daemon;
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DEV_BROWSER_DIR: &str = ".dev-browser";
const EMBEDDED_DAEMON: &str = include_str!("../../daemon/dist/daemon.bundle.mjs");
const EMBEDDED_SANDBOX_CLIENT: &str = include_str!("../../daemon/dist/sandbox-client.js");
const EMBEDDED_PACKAGE_JSON: &str = r#"{"name":"dev-browser-runtime","private":true,"type":"module","packageManager":"pnpm@10.30.1","dependencies":{"playwright":"^1.52.0","playwright-core":"^1.52.0","quickjs-emscripten":"^0.32.0"}}"#;

struct DaemonCommand {
    program: String,
    args: Vec<String>,
    current_dir: PathBuf,
    requires_runtime_install: bool,
}

pub fn ensure_daemon() -> Result<(), Box<dyn Error>> {
    if is_daemon_running() {
        return Ok(());
    }

    let command = find_daemon_command()?;
    if command.requires_runtime_install && !embedded_playwright_installed(&command.current_dir) {
        return Err(
            "Embedded daemon dependencies are missing. Run `dev-browser install` first.".into(),
        );
    }

    spawn_daemon(&command)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
        if is_daemon_running() {
            return Ok(());
        }
    }

    Err("Daemon failed to start within 5 seconds".into())
}

pub fn ensure_daemon_extracted() -> Result<PathBuf, Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    let daemon_path = base_dir.join("daemon.mjs");
    let package_json_path = base_dir.join("package.json");

    fs::create_dir_all(&base_dir)?;
    let sandbox_client_path = base_dir.join("sandbox-client.js");
    sync_text_file(&daemon_path, EMBEDDED_DAEMON)?;
    sync_text_file(&sandbox_client_path, EMBEDDED_SANDBOX_CLIENT)?;
    sync_text_file(&package_json_path, EMBEDDED_PACKAGE_JSON)?;

    Ok(daemon_path)
}

pub fn install_daemon_runtime() -> Result<(), Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    ensure_daemon_extracted()?;
    run_install_command("pnpm", &["install"], &base_dir)?;
    run_install_command(
        "pnpm",
        &["exec", "playwright", "install", "chromium"],
        &base_dir,
    )?;
    Ok(())
}

pub fn is_daemon_running() -> bool {
    let Some(pid) = daemon_pid() else {
        return false;
    };

    process_is_alive(pid) && connect_to_daemon().is_ok()
}

fn spawn_daemon(command: &DaemonCommand) -> io::Result<()> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.current_dir(&command.current_dir);
    process.stdin(Stdio::null());
    process.stdout(Stdio::null());
    process.stderr(Stdio::null());

    unsafe {
        process.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let _child = process.spawn()?;
    Ok(())
}

fn daemon_pid() -> Option<i32> {
    let pid_path = dirs::home_dir()?.join(".dev-browser").join("daemon.pid");
    let pid = fs::read_to_string(pid_path).ok()?;
    pid.trim().parse::<i32>().ok()
}

fn process_is_alive(pid: i32) -> bool {
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }

    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn find_daemon_command() -> Result<DaemonCommand, Box<dyn Error>> {
    if let Some(entry) = env::var_os("DEV_BROWSER_DAEMON") {
        return command_from_entry(PathBuf::from(entry));
    }

    let daemon_path = ensure_daemon_extracted()?;
    Ok(DaemonCommand {
        program: "node".to_string(),
        args: vec![daemon_path.to_string_lossy().into_owned()],
        current_dir: daemon_base_dir()?,
        requires_runtime_install: true,
    })
}

fn command_from_entry(entry: PathBuf) -> Result<DaemonCommand, Box<dyn Error>> {
    let entry = fs::canonicalize(entry)?;
    let current_dir = entry
        .parent()
        .ok_or("Daemon entrypoint has no parent directory")?
        .to_path_buf();

    match entry.extension().and_then(OsStr::to_str) {
        Some("js") | Some("mjs") | Some("cjs") => Ok(DaemonCommand {
            program: "node".to_string(),
            args: vec![entry.to_string_lossy().into_owned()],
            current_dir,
            requires_runtime_install: false,
        }),
        Some("ts") | Some("mts") | Some("cts") => {
            let tsx_cli = find_tsx_cli(&entry)?;
            Ok(DaemonCommand {
                program: "node".to_string(),
                args: vec![
                    tsx_cli.to_string_lossy().into_owned(),
                    entry.to_string_lossy().into_owned(),
                ],
                current_dir,
                requires_runtime_install: false,
            })
        }
        _ => Ok(DaemonCommand {
            program: entry.to_string_lossy().into_owned(),
            args: Vec::new(),
            current_dir,
            requires_runtime_install: false,
        }),
    }
}

fn find_tsx_cli(entry: &Path) -> Result<PathBuf, Box<dyn Error>> {
    for candidate in entry.ancestors() {
        let tsx_cli = candidate
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        if tsx_cli.is_file() {
            return Ok(tsx_cli);
        }
    }

    Err("Could not locate the tsx runtime required to launch the TypeScript daemon.".into())
}

fn daemon_base_dir() -> Result<PathBuf, Box<dyn Error>> {
    dirs::home_dir()
        .map(|path| path.join(DEV_BROWSER_DIR))
        .ok_or_else(|| {
            "Could not determine the home directory for the embedded daemon runtime.".into()
        })
}

fn embedded_playwright_installed(base_dir: &Path) -> bool {
    base_dir
        .join("node_modules")
        .join("playwright")
        .join("package.json")
        .is_file()
}

fn sync_text_file(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let needs_update = match fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };

    if needs_update {
        fs::write(path, contents)?;
    }

    Ok(())
}

fn run_install_command(
    program: &str,
    args: &[&str],
    current_dir: &Path,
) -> Result<(), Box<dyn Error>> {
    let status = Command::new(program)
        .args(args)
        .current_dir(current_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;

    if status.success() {
        return Ok(());
    }

    let reason = match status.code() {
        Some(code) => format!(
            "`{program} {}` failed with exit code {code}",
            args.join(" ")
        ),
        None => format!("`{program} {}` terminated by signal", args.join(" ")),
    };

    Err(reason.into())
}

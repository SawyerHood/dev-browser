use crate::connection::connect_to_daemon;
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DEV_BROWSER_DIR: &str = ".dev-browser";
const EMBEDDED_DAEMON: &str = include_str!("../../daemon/dist/daemon.bundle.mjs");
const EMBEDDED_SANDBOX_CLIENT: &str = include_str!("../../daemon/dist/sandbox-client.js");
const EMBEDDED_PACKAGE_JSON: &str = r#"{
  "name": "dev-browser-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "playwright": "1.58.2",
    "playwright-core": "1.58.2",
    "quickjs-emscripten": "^0.32.0"
  }
}"#;

struct DaemonCommand {
    program: String,
    args: Vec<String>,
    current_dir: PathBuf,
    requires_runtime_install: bool,
}

/// Marks an error as caused by the local tool environment — a missing
/// runtime dependency, the daemon failing to start/stop, or Chromium failing
/// to actually launch after `install` — rather than a generic CLI-side
/// failure or an upstream/script failure reported by the daemon itself.
/// `main.rs` downcasts to this type to select exit code 3 (tool-environment)
/// instead of the generic exit code 1.
#[derive(Debug)]
pub struct ToolEnvironmentError(pub String);

impl std::fmt::Display for ToolEnvironmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for ToolEnvironmentError {}

pub fn ensure_daemon() -> Result<(), Box<dyn Error>> {
    if is_daemon_running() {
        return Ok(());
    }

    // Hold an exclusive lock while spawning so concurrent CLI invocations on a
    // cold start cannot each spawn a daemon and race on the socket path. The
    // lock is released when the file handle drops.
    let _spawn_lock = acquire_spawn_lock()?;
    if is_daemon_running() {
        return Ok(());
    }

    let command = find_daemon_command()?;
    if command.requires_runtime_install && !embedded_runtime_installed(&command.current_dir) {
        return Err(ToolEnvironmentError(
            "Embedded daemon dependencies are missing. Run `dev-browser install` first."
                .to_string(),
        )
        .into());
    }

    spawn_daemon(&command)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
        if is_daemon_running() {
            return Ok(());
        }
    }

    Err(ToolEnvironmentError(format!(
        "Daemon failed to start within 5 seconds. Check the daemon log for details: {}",
        daemon_log_path_display()
    ))
    .into())
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
    run_install_command(npm_command(), &["install"], &base_dir)?;
    run_install_command(
        npm_command(),
        &["exec", "--", "playwright", "install", "chromium"],
        &base_dir,
    )?;
    // npm/playwright exiting 0 doesn't guarantee Chromium can actually
    // launch (missing system libs, corrupted download, etc. have all
    // previously reported success here). Probe a real launch before telling
    // the caller `install` succeeded.
    verify_chromium_launches(&base_dir)?;
    Ok(())
}

const CHROMIUM_LAUNCH_PROBE: &str = r#"import { chromium } from "playwright-core";

try {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(String((error && error.stack) || error) + "\n");
  process.exit(1);
}
"#;

fn verify_chromium_launches(base_dir: &Path) -> Result<(), Box<dyn Error>> {
    let probe_path = base_dir.join(format!(".chromium-launch-probe.{}.mjs", std::process::id()));
    fs::write(&probe_path, CHROMIUM_LAUNCH_PROBE)?;

    let run_result = Command::new("node")
        .arg(&probe_path)
        .current_dir(base_dir)
        .output();

    let _ = fs::remove_file(&probe_path);

    let output = run_result.map_err(|error| -> Box<dyn Error> {
        match error.kind() {
            io::ErrorKind::NotFound => ToolEnvironmentError(
                "Could not find `node` in PATH while verifying the Chromium install.".to_string(),
            )
            .into(),
            _ => format!("Failed to run the Chromium launch probe: {error}").into(),
        }
    })?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    interpret_chromium_probe_result(output.status.success(), &stderr)
        .map_err(|message| ToolEnvironmentError(message).into())
}

/// Pure decision logic split out from `verify_chromium_launches` so it can
/// be unit tested without actually spawning `node`/Chromium.
fn interpret_chromium_probe_result(success: bool, stderr: &str) -> Result<(), String> {
    if success {
        return Ok(());
    }

    let detail = stderr.trim();
    Err(format!(
        "`dev-browser install` finished, but Chromium failed to actually launch.{}\nThis usually means a system dependency is missing (see https://playwright.dev/docs/browsers#install-system-dependencies) or the Chromium binary is corrupted — try running `dev-browser install` again.",
        if detail.is_empty() {
            String::new()
        } else {
            format!("\n{detail}")
        }
    ))
}

pub fn is_daemon_running() -> bool {
    connect_to_daemon().is_ok()
}

fn acquire_spawn_lock() -> Result<fs::File, Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    fs::create_dir_all(&base_dir)?;
    let lock_file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(base_dir.join("daemon-spawn.lock"))?;

    // Use flock(2) rather than std::fs::File::lock so the CLI keeps a low MSRV
    // (File::lock was only stabilized in Rust 1.89). The advisory lock releases
    // when the returned handle drops. Best-effort on non-Unix: the daemon-side
    // bind also serializes concurrent starts.
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        if unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
    }

    Ok(lock_file)
}

pub fn current_daemon_pid() -> Option<i32> {
    daemon_pid()
}

pub fn wait_for_daemon_exit(pid: i32, timeout: Duration) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if daemon_has_exited(pid, connect_to_daemon().is_err()) {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err(ToolEnvironmentError(format!(
        "Daemon failed to stop within {} seconds. Check the daemon log for details: {}",
        timeout.as_secs(),
        daemon_log_path_display()
    ))
    .into())
}

/// A daemon is considered gone only once BOTH signals agree: its control
/// socket is unreachable AND its recorded pid is no longer a live process.
/// Socket-unreachability alone is not sufficient — it can also mean the
/// daemon is mid-shutdown (still tearing down browsers) or, in principle,
/// that a stale pid file points at an unrelated process. Consulting the pid
/// closes both gaps.
fn daemon_has_exited(pid: i32, daemon_unreachable: bool) -> bool {
    daemon_unreachable && !pid_is_running(pid)
}

#[cfg(unix)]
fn pid_is_running(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }

    // SAFETY: signal 0 sends no actual signal; kill(2) only performs its
    // existence/permission checks and reports the result via the return
    // value / errno.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(windows)]
fn pid_is_running(pid: i32) -> bool {
    use std::ffi::c_void;

    // Minimal raw bindings to avoid pulling in an extra crate just for a
    // liveness check. Mirrors the standard OpenProcess/GetExitCodeProcess
    // pattern used to check whether a pid is still alive on Windows.
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut c_void;
        fn CloseHandle(h_object: *mut c_void) -> i32;
        fn GetExitCodeProcess(h_process: *mut c_void, lp_exit_code: *mut u32) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    if pid <= 0 {
        return false;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return false;
        }

        let mut exit_code: u32 = 0;
        let got_exit_code = GetExitCodeProcess(handle, &mut exit_code as *mut u32);
        CloseHandle(handle);

        got_exit_code != 0 && exit_code == STILL_ACTIVE
    }
}

fn spawn_daemon(command: &DaemonCommand) -> io::Result<()> {
    // Daemon stdout/stderr are redirected to a log file rather than
    // discarded: a daemon crash (uncaught exception, disk-full, etc.) used
    // to be structurally invisible, surfacing only as a generic "Daemon
    // connection closed unexpectedly" on the client side. See
    // daemon_log_path() / the hints threaded through connection.rs and the
    // start/stop-timeout errors above.
    let stdout_log = open_daemon_log_file()?;
    let stderr_log = stdout_log.try_clone()?;

    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.current_dir(&command.current_dir);
    process.stdin(Stdio::null());
    process.stdout(Stdio::from(stdout_log));
    process.stderr(Stdio::from(stderr_log));

    #[cfg(unix)]
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

/// Cap on the daemon log before it gets rotated on the next spawn. Kept
/// simple (single `.1` backup, checked at spawn time) rather than a full
/// rotation scheme — the daemon spawns rarely (only on cold start), so this
/// is enough to bound disk usage without adding a background rotation task.
const DAEMON_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

fn open_daemon_log_file() -> io::Result<fs::File> {
    let logs_dir = daemon_logs_dir()?;
    fs::create_dir_all(&logs_dir)?;
    let log_path = logs_dir.join("daemon.log");

    if let Ok(metadata) = fs::metadata(&log_path) {
        if metadata.len() > DAEMON_LOG_MAX_BYTES {
            let rotated_path = logs_dir.join("daemon.log.1");
            let _ = fs::remove_file(&rotated_path);
            let _ = fs::rename(&log_path, &rotated_path);
        }
    }

    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
}

fn daemon_logs_dir() -> io::Result<PathBuf> {
    dirs::home_dir()
        .map(|path| path.join(DEV_BROWSER_DIR).join("logs"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine the home directory for daemon logs.",
            )
        })
}

/// Path to the daemon's stdout/stderr log file. Referenced from the
/// connection-closed error (connection.rs) and the start/stop-timeout
/// errors above so an agent hitting an opaque daemon failure has a concrete
/// next step instead of just "Daemon connection closed unexpectedly".
pub fn daemon_log_path() -> io::Result<PathBuf> {
    Ok(daemon_logs_dir()?.join("daemon.log"))
}

/// `daemon_log_path()` with a best-effort display fallback for error
/// messages that can't propagate an inner io::Error (e.g. because they're
/// already being constructed as a `String` inside a `ToolEnvironmentError`).
fn daemon_log_path_display() -> String {
    daemon_log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "~/.dev-browser/logs/daemon.log".to_string())
}

fn daemon_pid() -> Option<i32> {
    let pid_path = dirs::home_dir()?.join(".dev-browser").join("daemon.pid");
    let pid = fs::read_to_string(pid_path).ok()?;
    pid.trim().parse::<i32>().ok()
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

    Err(
        ToolEnvironmentError(
            "Could not locate the tsx runtime required to launch the TypeScript daemon."
                .to_string(),
        )
        .into(),
    )
}

fn daemon_base_dir() -> Result<PathBuf, Box<dyn Error>> {
    dirs::home_dir()
        .map(|path| path.join(DEV_BROWSER_DIR))
        .ok_or_else(|| {
            ToolEnvironmentError(
                "Could not determine the home directory for the embedded daemon runtime."
                    .to_string(),
            )
            .into()
        })
}

fn embedded_runtime_installed(base_dir: &Path) -> bool {
    dependency_installed(base_dir, "playwright")
        && dependency_installed(base_dir, "quickjs-emscripten")
}

fn dependency_installed(base_dir: &Path, package_name: &str) -> bool {
    base_dir
        .join("node_modules")
        .join(package_name)
        .join("package.json")
        .is_file()
}

fn npm_command() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn sync_text_file(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let needs_update = match fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };

    if needs_update {
        // Write to a per-process temp file and rename into place so a
        // concurrent daemon spawn reading this file never observes a partial
        // (truncated) write.
        let tmp_path = path.with_extension(format!("tmp.{}", std::process::id()));
        fs::write(&tmp_path, contents)?;
        fs::rename(&tmp_path, path)?;
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
        .status()
        .map_err(|error| -> Box<dyn Error> {
            match error.kind() {
                io::ErrorKind::NotFound => ToolEnvironmentError(format!(
                    "Could not find `{program}` in PATH while setting up the embedded daemon runtime in {}. Install Node.js/npm and run `dev-browser install` again.",
                    current_dir.display()
                ))
                .into(),
                _ => ToolEnvironmentError(format!(
                    "Failed to run `{program} {}` in {}: {error}",
                    args.join(" "),
                    current_dir.display()
                ))
                .into(),
            }
        })?;

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

    Err(ToolEnvironmentError(reason).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- CLI-03: daemon_has_exited must actually consult the pid ----------

    #[test]
    fn daemon_has_exited_false_for_a_live_pid_even_if_socket_unreachable() {
        // Regression test for the bug: the old implementation ignored `pid`
        // entirely and returned `daemon_unreachable` verbatim, so `stop`
        // could report success purely because the socket was momentarily
        // unreachable while the daemon was still alive/mid-shutdown.
        let live_pid = std::process::id() as i32;
        assert!(!daemon_has_exited(live_pid, true));
    }

    #[test]
    fn daemon_has_exited_false_while_socket_is_still_reachable() {
        assert!(!daemon_has_exited(i32::MAX, false));
    }

    #[test]
    fn daemon_has_exited_true_when_socket_unreachable_and_pid_gone() {
        assert!(daemon_has_exited(i32::MAX, true));
    }

    #[test]
    fn pid_is_running_true_for_own_process() {
        assert!(pid_is_running(std::process::id() as i32));
    }

    #[test]
    fn pid_is_running_false_for_non_positive_pid() {
        assert!(!pid_is_running(0));
        assert!(!pid_is_running(-1));
    }

    // --- P1-3: daemon crash logging ----------------------------------------

    #[test]
    fn daemon_log_path_is_under_dev_browser_logs_dir() {
        let path = daemon_log_path().expect("home dir should resolve in the test environment");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("daemon.log")
        );

        let parent = path.parent().expect("daemon.log should have a parent dir");
        assert_eq!(
            parent.file_name().and_then(|name| name.to_str()),
            Some("logs")
        );

        let grandparent = parent
            .parent()
            .expect("logs dir should have a parent dir");
        assert_eq!(
            grandparent.file_name().and_then(|name| name.to_str()),
            Some(DEV_BROWSER_DIR)
        );
    }

    #[test]
    fn daemon_log_path_display_never_panics_and_mentions_daemon_log() {
        let display = daemon_log_path_display();
        assert!(display.ends_with("daemon.log"));
    }

    // --- P3-4: Chromium launch verification (pure decision logic) ---------

    #[test]
    fn chromium_probe_success_returns_ok() {
        assert!(interpret_chromium_probe_result(true, "").is_ok());
    }

    #[test]
    fn chromium_probe_failure_names_hint_and_includes_stderr_detail() {
        let error =
            interpret_chromium_probe_result(false, "libnss3.so: cannot open shared object file")
                .expect_err("a failed probe must be Err");
        assert!(error.contains("Chromium failed to actually launch"));
        assert!(error.contains("libnss3.so"));
        assert!(error.contains("dev-browser install"));
    }

    #[test]
    fn chromium_probe_failure_without_stderr_still_names_the_hint() {
        let error = interpret_chromium_probe_result(false, "")
            .expect_err("a failed probe must be Err even with empty stderr");
        assert!(error.contains("Chromium failed to actually launch"));
        assert!(error.contains("install-system-dependencies"));
    }

    // --- P0-4: ToolEnvironmentError is a real std::error::Error -----------

    #[test]
    fn tool_environment_error_displays_its_message() {
        let error = ToolEnvironmentError("boom".to_string());
        assert_eq!(error.to_string(), "boom");
    }
}

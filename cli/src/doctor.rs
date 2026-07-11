//! `dev-browser doctor` — read-only diagnostics for the on-disk state under
//! `~/.dev-browser/` (daemon status, disk usage, stale named-browser
//! profiles), plus an opt-in, dry-run-by-default garbage collector for that
//! same directory tree.
//!
//! Closes the field finding that `~/.dev-browser/tmp/` (163 MB / 531 files
//! observed) and `~/.dev-browser/browsers/` (1.4 GB / 25 stale profiles
//! observed) have no GC path, which has forced agents into a blocked
//! `rm -rf` (P3-6 in `agent_ergonomics_audit/audit/playbook.md`).
//!
//! Safety model: `doctor --gc` only ever *plans* deletion — it prints what
//! would be removed and never touches disk — until `--yes` is also passed.
//! Named browser profiles (which can hold logged-in session state) are never
//! GC candidates unless `--include-browser-profiles` is passed too. Every
//! delete is re-verified with [`is_contained`] immediately before it runs,
//! so nothing outside `~/.dev-browser` is ever touched even if a plan were
//! reused after the filesystem changed underneath it.

use std::error::Error;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::daemon::{
    browsers_dir, current_daemon_pid, daemon_base_dir, daemon_log_path, daemon_logs_dir,
    is_daemon_running, tmp_dir,
};

/// Default staleness threshold, in days of inactivity, before a named
/// browser profile is flagged in `doctor` output and becomes a GC candidate
/// when `--gc --include-browser-profiles` is passed.
pub const DEFAULT_STALE_DAYS: u64 = 30;

/// Default minimum age, in days, before a `tmp/` entry is eligible for GC.
/// Conservative on purpose: `doctor --gc` still only *plans* deletion until
/// `--yes` is also passed, but the age floor avoids ever listing a file an
/// agent wrote moments ago in a concurrent session.
pub const DEFAULT_MIN_AGE_DAYS: u64 = 1;

const SECONDS_PER_DAY: u64 = 24 * 60 * 60;

pub struct DoctorOptions {
    pub json: bool,
    pub gc: bool,
    pub confirm: bool,
    pub include_browser_profiles: bool,
    pub stale_days: u64,
    pub min_age_days: u64,
}

/// Disk-usage snapshot for one directory under `~/.dev-browser/`.
#[derive(Debug, Clone)]
struct DirReport {
    label: &'static str,
    path: PathBuf,
    exists: bool,
    total_bytes: u64,
    file_count: u64,
}

/// One named browser profile directory under `~/.dev-browser/browsers/`.
#[derive(Debug, Clone)]
struct BrowserProfileReport {
    name: String,
    path: PathBuf,
    total_bytes: u64,
    file_count: u64,
    age_days: Option<u64>,
    stale: bool,
}

/// A single GC candidate — a `tmp/` entry or (opt-in) a stale browser
/// profile — with the size that would be reclaimed if deleted.
#[derive(Debug, Clone)]
struct GcCandidate {
    kind: &'static str,
    path: PathBuf,
    bytes: u64,
    age_days: Option<u64>,
}

struct GcResult {
    deleted: Vec<GcCandidate>,
    failed: Vec<(PathBuf, String)>,
    reclaimed_bytes: u64,
}

struct DoctorReport {
    base_dir: PathBuf,
    base_dir_exists: bool,
    daemon_running: bool,
    daemon_pid: Option<i32>,
    log_path: Option<PathBuf>,
    dirs: Vec<DirReport>,
    browser_profiles: Vec<BrowserProfileReport>,
    stale_days: u64,
}

pub fn run_doctor(options: DoctorOptions) -> Result<i32, Box<dyn Error>> {
    if options.confirm && !options.gc {
        eprintln!("Warning: --yes has no effect without --gc; nothing was planned to delete.");
    }
    if options.include_browser_profiles && !options.gc {
        eprintln!("Warning: --include-browser-profiles has no effect without --gc.");
    }

    let report = build_report(options.stale_days)?;

    let gc_plan = if options.gc {
        Some(build_gc_plan(&report, &options))
    } else {
        None
    };

    let gc_result = match (&gc_plan, options.confirm) {
        (Some(plan), true) => Some(execute_gc_plan(&report.base_dir, plan)),
        _ => None,
    };

    if options.json {
        print_json(&report, gc_plan.as_deref(), gc_result.as_ref(), &options);
    } else {
        print_human(&report, gc_plan.as_deref(), gc_result.as_ref(), &options);
    }

    Ok(0)
}

fn build_report(stale_days: u64) -> Result<DoctorReport, Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    let base_dir_exists = base_dir.is_dir();

    let daemon_running = is_daemon_running();
    let daemon_pid = current_daemon_pid();
    let log_path = daemon_log_path().ok();

    let tmp_path = tmp_dir()?;
    let browsers_path = browsers_dir()?;
    let logs_path = daemon_logs_dir().unwrap_or_else(|_| base_dir.join("logs"));

    let dirs = vec![
        dir_report("tmp", tmp_path),
        dir_report("browsers", browsers_path.clone()),
        dir_report("logs", logs_path),
    ];

    let browser_profiles = list_browser_profiles(&browsers_path, stale_days);

    Ok(DoctorReport {
        base_dir,
        base_dir_exists,
        daemon_running,
        daemon_pid,
        log_path,
        dirs,
        browser_profiles,
        stale_days,
    })
}

fn dir_report(label: &'static str, path: PathBuf) -> DirReport {
    if !path.is_dir() {
        return DirReport {
            label,
            path,
            exists: false,
            total_bytes: 0,
            file_count: 0,
        };
    }

    let walk = walk_dir(&path);
    DirReport {
        label,
        path,
        exists: true,
        total_bytes: walk.total_bytes,
        file_count: walk.file_count,
    }
}

fn list_browser_profiles(browsers_path: &Path, stale_days: u64) -> Vec<BrowserProfileReport> {
    let mut profiles = Vec::new();
    let entries = match fs::read_dir(browsers_path) {
        Ok(entries) => entries,
        Err(_) => return profiles,
    };

    let now = SystemTime::now();

    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let walk = walk_dir(&path);
        let age_days = age_in_days(walk.newest_modified, now);
        let stale = age_days.map(|days| days >= stale_days).unwrap_or(false);

        profiles.push(BrowserProfileReport {
            name,
            path,
            total_bytes: walk.total_bytes,
            file_count: walk.file_count,
            age_days,
            stale,
        });
    }

    profiles.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
    profiles
}

fn age_in_days(modified: Option<SystemTime>, now: SystemTime) -> Option<u64> {
    modified
        .and_then(|modified| now.duration_since(modified).ok())
        .map(|elapsed| elapsed.as_secs() / SECONDS_PER_DAY)
}

struct DirWalk {
    total_bytes: u64,
    file_count: u64,
    newest_modified: Option<SystemTime>,
}

/// Recursively sums file sizes/counts under `root` and tracks the newest
/// file-modification time seen, used as a lightweight "last used" signal for
/// staleness. Symlinks are skipped rather than followed (`entry.file_type()`
/// does not follow symlinks), avoiding both double-counting and the
/// possibility of an infinite cycle from a symlink loop.
fn walk_dir(root: &Path) -> DirWalk {
    let mut total_bytes = 0u64;
    let mut file_count = 0u64;
    let mut newest_modified: Option<SystemTime> = None;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };

            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            if let Ok(metadata) = entry.metadata() {
                total_bytes += metadata.len();
                file_count += 1;

                if let Ok(modified) = metadata.modified() {
                    newest_modified = Some(match newest_modified {
                        Some(current) if current >= modified => current,
                        _ => modified,
                    });
                }
            }
        }
    }

    DirWalk {
        total_bytes,
        file_count,
        newest_modified,
    }
}

/// True only if `candidate` is lexically inside `root`, with no `..`
/// component anywhere that could walk it back outside — the guard every GC
/// deletion path is required to pass before touching disk.
/// `Path::starts_with` alone is not sufficient: it compares components
/// without resolving `..`, so e.g. `root.join("browsers/../../etc")` still
/// satisfies `starts_with(root)`.
fn is_contained(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
        && !candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn build_gc_plan(report: &DoctorReport, options: &DoctorOptions) -> Vec<GcCandidate> {
    let mut candidates = Vec::new();
    let now = SystemTime::now();

    if let Some(tmp_report) = report.dirs.iter().find(|dir| dir.label == "tmp") {
        if tmp_report.exists {
            candidates.extend(tmp_gc_candidates(
                &report.base_dir,
                &tmp_report.path,
                options.min_age_days,
                now,
            ));
        }
    }

    if options.include_browser_profiles {
        for profile in &report.browser_profiles {
            if profile.stale && is_contained(&report.base_dir, &profile.path) {
                candidates.push(GcCandidate {
                    kind: "browser-profile",
                    path: profile.path.clone(),
                    bytes: profile.total_bytes,
                    age_days: profile.age_days,
                });
            }
        }
    }

    candidates
}

/// Lists direct children of `tmp/` (files or subdirectories) whose newest
/// contained file is at least `min_age_days` old. Each direct child is a
/// single GC unit — the whole subtree deletes together — since agents
/// address `tmp/` entries by their top-level name (`saveScreenshot`,
/// `writeFile`). Every candidate is re-checked with [`is_contained`] against
/// `base_dir`, so even a caller bug that pointed `tmp_path` outside
/// `base_dir` could never surface a candidate outside it.
fn tmp_gc_candidates(
    base_dir: &Path,
    tmp_path: &Path,
    min_age_days: u64,
    now: SystemTime,
) -> Vec<GcCandidate> {
    let mut candidates = Vec::new();
    let entries = match fs::read_dir(tmp_path) {
        Ok(entries) => entries,
        Err(_) => return candidates,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_contained(base_dir, &path) {
            continue;
        }

        let (bytes, age_days) = match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {
                let walk = walk_dir(&path);
                (walk.total_bytes, age_in_days(walk.newest_modified, now))
            }
            _ => {
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                let age = age_in_days(metadata.modified().ok(), now);
                (metadata.len(), age)
            }
        };

        let eligible = age_days.map(|days| days >= min_age_days).unwrap_or(false);
        if eligible {
            candidates.push(GcCandidate {
                kind: "tmp-entry",
                path,
                bytes,
                age_days,
            });
        }
    }

    candidates
}

/// Deletes every candidate in `plan`. Every path is re-verified against
/// [`is_contained`] immediately before the delete call (not just when the
/// plan was built) — belt-and-suspenders against a plan being reused after
/// on-disk state changed. Only ever called when the caller has already
/// confirmed `--gc --yes`.
fn execute_gc_plan(base_dir: &Path, plan: &[GcCandidate]) -> GcResult {
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    let mut reclaimed_bytes = 0u64;

    for candidate in plan {
        if !is_contained(base_dir, &candidate.path) {
            failed.push((
                candidate.path.clone(),
                "refused: path is not contained within ~/.dev-browser".to_string(),
            ));
            continue;
        }

        let result = if candidate.path.is_dir() {
            fs::remove_dir_all(&candidate.path)
        } else {
            fs::remove_file(&candidate.path)
        };

        match result {
            Ok(()) => {
                reclaimed_bytes += candidate.bytes;
                deleted.push(candidate.clone());
            }
            Err(error) => failed.push((candidate.path.clone(), error.to_string())),
        }
    }

    GcResult {
        deleted,
        failed,
        reclaimed_bytes,
    }
}

/// Formats a byte count for humans (`1536` -> `"1.5 KB"`). Kept as a pure
/// function so it's independently unit-testable.
fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

    if bytes < 1024 {
        return format!("{bytes} B");
    }

    let mut size = bytes as f64;
    let mut unit_index = 0usize;
    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }

    format!("{size:.1} {}", UNITS[unit_index])
}

fn print_human(
    report: &DoctorReport,
    gc_plan: Option<&[GcCandidate]>,
    gc_result: Option<&GcResult>,
    options: &DoctorOptions,
) {
    println!("dev-browser doctor");
    println!();
    println!("Base dir: {}", report.base_dir.display());
    if !report.base_dir_exists {
        println!("  (does not exist yet -- nothing has run that touches ~/.dev-browser)");
    }
    println!(
        "Daemon: {}",
        match (report.daemon_running, report.daemon_pid) {
            (true, Some(pid)) => format!("running (pid {pid})"),
            (true, None) => "running (pid unknown)".to_string(),
            (false, _) => "not running".to_string(),
        }
    );
    if let Some(log_path) = &report.log_path {
        println!("Daemon log: {}", log_path.display());
    }
    println!();

    println!("Disk usage:");
    for dir in &report.dirs {
        if dir.exists {
            println!(
                "  {:<10} {:>10}  ({} files)  {}",
                dir.label,
                human_size(dir.total_bytes),
                dir.file_count,
                dir.path.display()
            );
        } else {
            println!("  {:<10} (missing)  {}", dir.label, dir.path.display());
        }
    }
    println!();

    if report.browser_profiles.is_empty() {
        println!("Browser profiles: none.");
    } else {
        println!(
            "Browser profiles ({} total, stale threshold {} days):",
            report.browser_profiles.len(),
            report.stale_days
        );
        for profile in &report.browser_profiles {
            let age = profile
                .age_days
                .map(|days| format!("{days}d idle"))
                .unwrap_or_else(|| "age unknown".to_string());
            let flag = if profile.stale { "  [STALE]" } else { "" };
            println!(
                "  {:<20} {:>10}  {}{}",
                profile.name,
                human_size(profile.total_bytes),
                age,
                flag
            );
        }
    }

    if let Some(plan) = gc_plan {
        println!();
        if plan.is_empty() {
            println!("GC plan: nothing eligible (nothing older than the configured age thresholds).");
        } else {
            let total_bytes: u64 = plan.iter().map(|candidate| candidate.bytes).sum();
            let verb = if options.confirm { "Deleted" } else { "Would delete" };
            println!(
                "GC plan ({} items, {} reclaimable):",
                plan.len(),
                human_size(total_bytes)
            );
            for candidate in plan {
                println!(
                    "  {verb}: [{}] {}  ({})",
                    candidate.kind,
                    candidate.path.display(),
                    human_size(candidate.bytes)
                );
            }

            if !options.confirm {
                println!();
                println!(
                    "This was a DRY RUN. Re-run with `--gc --yes` to actually delete these {} items.",
                    plan.len()
                );
            }
        }
    }

    if let Some(result) = gc_result {
        println!();
        println!(
            "GC result: deleted {} items, reclaimed {}.",
            result.deleted.len(),
            human_size(result.reclaimed_bytes)
        );
        for (path, message) in &result.failed {
            eprintln!("  failed to delete {}: {message}", path.display());
        }
    }
}

fn print_json(
    report: &DoctorReport,
    gc_plan: Option<&[GcCandidate]>,
    gc_result: Option<&GcResult>,
    options: &DoctorOptions,
) {
    let document = json!({
        "base_dir": report.base_dir.display().to_string(),
        "base_dir_exists": report.base_dir_exists,
        "daemon": {
            "running": report.daemon_running,
            "pid": report.daemon_pid,
        },
        "log_path": report.log_path.as_ref().map(|path| path.display().to_string()),
        "dirs": report.dirs.iter().map(|dir| json!({
            "label": dir.label,
            "path": dir.path.display().to_string(),
            "exists": dir.exists,
            "total_bytes": dir.total_bytes,
            "total_human": human_size(dir.total_bytes),
            "file_count": dir.file_count,
        })).collect::<Vec<Value>>(),
        "browser_profiles": report.browser_profiles.iter().map(|profile| json!({
            "name": profile.name,
            "path": profile.path.display().to_string(),
            "total_bytes": profile.total_bytes,
            "total_human": human_size(profile.total_bytes),
            "file_count": profile.file_count,
            "age_days": profile.age_days,
            "stale": profile.stale,
        })).collect::<Vec<Value>>(),
        "stale_days_threshold": report.stale_days,
        "gc": gc_plan.map(|plan| {
            json!({
                "requested": true,
                "confirmed": options.confirm,
                "min_age_days": options.min_age_days,
                "include_browser_profiles": options.include_browser_profiles,
                "candidates": plan.iter().map(|candidate| json!({
                    "kind": candidate.kind,
                    "path": candidate.path.display().to_string(),
                    "bytes": candidate.bytes,
                    "age_days": candidate.age_days,
                })).collect::<Vec<Value>>(),
                "reclaimable_bytes": plan.iter().map(|candidate| candidate.bytes).sum::<u64>(),
                "result": gc_result.map(|result| json!({
                    "deleted_count": result.deleted.len(),
                    "reclaimed_bytes": result.reclaimed_bytes,
                    "failed": result.failed.iter().map(|(path, message)| json!({
                        "path": path.display().to_string(),
                        "error": message,
                    })).collect::<Vec<Value>>(),
                })),
            })
        }),
    });

    println!(
        "{}",
        serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_string())
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        path.push(format!(
            "dev-browser-doctor-test-{label}-{nonce}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp test dir");
        path
    }

    // --- human_size ----------------------------------------------------

    #[test]
    fn human_size_formats_bytes() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
    }

    #[test]
    fn human_size_formats_kilobytes() {
        assert_eq!(human_size(1536), "1.5 KB");
    }

    #[test]
    fn human_size_formats_megabytes_and_gigabytes() {
        assert_eq!(human_size(1_572_864), "1.5 MB");
        assert_eq!(human_size(1_610_612_736), "1.5 GB");
    }

    // --- is_contained ----------------------------------------------------

    #[test]
    fn is_contained_accepts_a_direct_child() {
        let root = Path::new("/home/user/.dev-browser");
        let candidate = root.join("tmp").join("screenshot.png");
        assert!(is_contained(root, &candidate));
    }

    #[test]
    fn is_contained_rejects_a_sibling_directory() {
        let root = Path::new("/home/user/.dev-browser");
        let candidate = Path::new("/home/user/other-dir/file.txt");
        assert!(!is_contained(root, &candidate));
    }

    #[test]
    fn is_contained_rejects_parent_dir_traversal_even_when_lexically_prefixed() {
        let root = Path::new("/home/user/.dev-browser");
        // Lexically this still starts with `root`'s components, which is
        // exactly why `starts_with` alone is not a safe containment check.
        let candidate = root
            .join("browsers")
            .join("..")
            .join("..")
            .join("etc")
            .join("passwd");
        assert!(!is_contained(root, &candidate));
    }

    // --- walk_dir against a real temp dir ---------------------------------

    #[test]
    fn walk_dir_sums_nested_file_sizes() {
        let root = unique_temp_dir("walk");
        fs::write(root.join("a.txt"), b"12345").unwrap();
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("b.txt"), b"1234567890").unwrap();

        let walk = walk_dir(&root);
        assert_eq!(walk.total_bytes, 15);
        assert_eq!(walk.file_count, 2);
        assert!(walk.newest_modified.is_some());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn walk_dir_on_missing_dir_returns_zeroes() {
        let missing = std::env::temp_dir().join("dev-browser-doctor-test-missing-nonexistent");
        let walk = walk_dir(&missing);
        assert_eq!(walk.total_bytes, 0);
        assert_eq!(walk.file_count, 0);
        assert!(walk.newest_modified.is_none());
    }

    // --- tmp_gc_candidates: age-gating -------------------------------------

    #[test]
    fn tmp_gc_candidates_skips_entries_newer_than_min_age() {
        let base = unique_temp_dir("gc-fresh");
        let tmp = base.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("fresh.png"), b"data").unwrap();

        let candidates = tmp_gc_candidates(&base, &tmp, 30, SystemTime::now());
        assert!(
            candidates.is_empty(),
            "a just-written file must not be GC-eligible at a 30-day floor"
        );

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn tmp_gc_candidates_includes_entries_older_than_min_age() {
        let base = unique_temp_dir("gc-stale");
        let tmp = base.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("stale.png"), b"data").unwrap();

        // min_age_days = 0 means "anything not newer than right now" is
        // eligible, without needing to fabricate an old mtime.
        let candidates = tmp_gc_candidates(&base, &tmp, 0, SystemTime::now());
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].kind, "tmp-entry");

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn tmp_gc_candidates_never_escapes_base_dir() {
        // Defense in depth: even if tmp_path were pointed outside base_dir
        // (a caller bug), tmp_gc_candidates must not surface it as a
        // candidate, because every entry is re-checked with is_contained.
        let base = unique_temp_dir("gc-outside-base");
        let outside_tmp = unique_temp_dir("gc-outside-tmp");
        fs::write(outside_tmp.join("escaped.png"), b"data").unwrap();

        let candidates = tmp_gc_candidates(&base, &outside_tmp, 0, SystemTime::now());
        assert!(
            candidates.is_empty(),
            "entries outside base_dir must never be GC candidates"
        );

        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&outside_tmp).ok();
    }

    // --- execute_gc_plan: containment guard is enforced at delete time ---

    #[test]
    fn execute_gc_plan_refuses_to_delete_outside_base_dir() {
        let base = unique_temp_dir("exec-base");
        let outside = unique_temp_dir("exec-outside");
        let victim = outside.join("do-not-delete.png");
        fs::write(&victim, b"data").unwrap();

        let plan = vec![GcCandidate {
            kind: "tmp-entry",
            path: victim.clone(),
            bytes: 4,
            age_days: Some(10),
        }];

        let result = execute_gc_plan(&base, &plan);
        assert_eq!(result.deleted.len(), 0);
        assert_eq!(result.failed.len(), 1);
        assert!(
            victim.exists(),
            "path outside base_dir must survive execute_gc_plan"
        );

        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn execute_gc_plan_deletes_contained_candidates_and_reports_reclaimed_bytes() {
        let base = unique_temp_dir("exec-contained");
        let tmp = base.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        let victim = tmp.join("old.png");
        fs::write(&victim, b"12345").unwrap();

        let plan = vec![GcCandidate {
            kind: "tmp-entry",
            path: victim.clone(),
            bytes: 5,
            age_days: Some(10),
        }];

        let result = execute_gc_plan(&base, &plan);
        assert_eq!(result.deleted.len(), 1);
        assert_eq!(result.reclaimed_bytes, 5);
        assert!(!victim.exists());

        fs::remove_dir_all(&base).ok();
    }

    // --- build_gc_plan: dry-run-by-default — a plan alone never deletes --

    #[test]
    fn build_gc_plan_is_pure_and_never_touches_disk() {
        let base = unique_temp_dir("plan-only");
        let tmp = base.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("old.png"), b"12345").unwrap();

        let report = DoctorReport {
            base_dir: base.clone(),
            base_dir_exists: true,
            daemon_running: false,
            daemon_pid: None,
            log_path: None,
            dirs: vec![DirReport {
                label: "tmp",
                path: tmp.clone(),
                exists: true,
                total_bytes: 5,
                file_count: 1,
            }],
            browser_profiles: Vec::new(),
            stale_days: DEFAULT_STALE_DAYS,
        };
        let options = DoctorOptions {
            json: false,
            gc: true,
            confirm: false,
            include_browser_profiles: false,
            stale_days: DEFAULT_STALE_DAYS,
            min_age_days: 0,
        };

        let plan = build_gc_plan(&report, &options);
        assert_eq!(plan.len(), 1);
        assert!(
            tmp.join("old.png").exists(),
            "building a plan must never delete"
        );

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn build_gc_plan_includes_stale_browser_profiles_only_when_opted_in() {
        let base = unique_temp_dir("plan-profiles");
        let profile_path = base.join("browsers").join("stale-one");
        fs::create_dir_all(&profile_path).unwrap();

        let report = DoctorReport {
            base_dir: base.clone(),
            base_dir_exists: true,
            daemon_running: false,
            daemon_pid: None,
            log_path: None,
            dirs: Vec::new(),
            browser_profiles: vec![BrowserProfileReport {
                name: "stale-one".to_string(),
                path: profile_path,
                total_bytes: 1024,
                file_count: 3,
                age_days: Some(90),
                stale: true,
            }],
            stale_days: DEFAULT_STALE_DAYS,
        };

        let opted_out = DoctorOptions {
            json: false,
            gc: true,
            confirm: false,
            include_browser_profiles: false,
            stale_days: DEFAULT_STALE_DAYS,
            min_age_days: DEFAULT_MIN_AGE_DAYS,
        };
        assert!(build_gc_plan(&report, &opted_out).is_empty());

        let opted_in = DoctorOptions {
            include_browser_profiles: true,
            ..opted_out
        };
        let plan = build_gc_plan(&report, &opted_in);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].kind, "browser-profile");

        fs::remove_dir_all(&base).ok();
    }
}

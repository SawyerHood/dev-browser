use dialoguer::{theme::ColorfulTheme, MultiSelect};
use std::error::Error;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

const EMBEDDED_DEV_BROWSER_SKILL: &str = include_str!("../../skills/dev-browser/SKILL.md");

struct InstallTarget {
    prompt_label: &'static str,
    root_display: &'static str,
    file_display: &'static str,
    root_relative_path: &'static str,
}

const INSTALL_TARGETS: [InstallTarget; 2] = [
    InstallTarget {
        prompt_label: "~/.claude/skills/dev-browser/",
        root_display: "~/.claude/skills",
        file_display: "~/.claude/skills/dev-browser/SKILL.md",
        root_relative_path: ".claude/skills",
    },
    InstallTarget {
        prompt_label: "~/.agents/skills/dev-browser/",
        root_display: "~/.agents/skills",
        file_display: "~/.agents/skills/dev-browser/SKILL.md",
        root_relative_path: ".agents/skills",
    },
];

enum SyncResult {
    Installed,
    Updated,
    AlreadyInstalled,
}

pub fn install_skill() -> Result<(), Box<dyn Error>> {
    if !interactive_terminal_available() {
        return Err("`dev-browser install-skill` requires an interactive terminal.".into());
    }

    let home_dir =
        dirs::home_dir().ok_or("Could not determine the home directory for skill installation.")?;

    let Some(selections) = prompt_for_install_targets()? else {
        println!("Cancelled.");
        return Ok(());
    };

    if selections.is_empty() {
        println!("No install targets selected.");
        return Ok(());
    }

    for selection in selections {
        let target = &INSTALL_TARGETS[selection];
        let result = install_target(&home_dir, target)?;
        match result {
            SyncResult::Installed => {
                println!("Installed dev-browser skill to {}", target.file_display);
            }
            SyncResult::Updated => {
                println!("Updated dev-browser skill at {}", target.file_display);
            }
            SyncResult::AlreadyInstalled => {
                println!(
                    "dev-browser skill is already installed at {}",
                    target.file_display
                );
            }
        }
    }

    Ok(())
}

fn prompt_for_install_targets() -> Result<Option<Vec<usize>>, Box<dyn Error>> {
    let options: Vec<&str> = INSTALL_TARGETS
        .iter()
        .map(|target| target.prompt_label)
        .collect();
    let defaults = vec![true; options.len()];

    let selections = MultiSelect::with_theme(&ColorfulTheme::default())
        .with_prompt("Select skill directories to install dev-browser into")
        .items(&options)
        .defaults(&defaults)
        .interact_opt()?;

    Ok(selections)
}

fn install_target(home_dir: &Path, target: &InstallTarget) -> Result<SyncResult, Box<dyn Error>> {
    let root_dir = home_dir.join(target.root_relative_path);
    ensure_directory(&root_dir, target.root_display, true)?;

    let skill_dir = root_dir.join("dev-browser");
    ensure_directory(&skill_dir, target.prompt_label.trim_end_matches('/'), false)?;

    let skill_file = skill_dir.join("SKILL.md");
    sync_skill_file(&skill_file)
}

fn ensure_directory(
    path: &Path,
    display_path: &str,
    announce_create: bool,
) -> Result<(), Box<dyn Error>> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if metadata.is_dir() {
                return Ok(());
            }

            Err(format!("{display_path} exists but is not a directory.").into())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|create_error| {
                format!("Failed to create {display_path}: {create_error}")
            })?;
            if announce_create {
                println!("Created {display_path}");
            }
            Ok(())
        }
        Err(error) => Err(format!("Failed to inspect {display_path}: {error}").into()),
    }
}

fn sync_skill_file(path: &Path) -> Result<SyncResult, Box<dyn Error>> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(format!("{} exists but is not a file.", path.display()).into());
            }

            let existing = fs::read_to_string(path)
                .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
            if existing == EMBEDDED_DEV_BROWSER_SKILL {
                return Ok(SyncResult::AlreadyInstalled);
            }

            atomic_write(path, EMBEDDED_DEV_BROWSER_SKILL)?;
            Ok(SyncResult::Updated)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            atomic_write(path, EMBEDDED_DEV_BROWSER_SKILL)?;
            Ok(SyncResult::Installed)
        }
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display()).into()),
    }
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let temp_path = temp_path_for(path)?;
    fs::write(&temp_path, contents)
        .map_err(|error| format!("Failed to write {}: {error}", temp_path.display()))?;

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Failed to replace {}: {error}", path.display()).into());
    }

    Ok(())
}

fn temp_path_for(path: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Could not determine a file name for {}", path.display()))?
        .to_string_lossy();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    Ok(path.with_file_name(format!(".{file_name}.tmp-{}-{nonce}", process::id())))
}

fn interactive_terminal_available() -> bool {
    io::stdin().is_terminal() && io::stderr().is_terminal()
}

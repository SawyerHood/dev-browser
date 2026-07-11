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

const INSTALL_TARGETS: [InstallTarget; 3] = [
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
    InstallTarget {
        prompt_label: "~/.codex/skills/dev-browser/",
        root_display: "~/.codex/skills",
        file_display: "~/.codex/skills/dev-browser/SKILL.md",
        root_relative_path: ".codex/skills",
    },
];

enum SyncResult {
    Installed,
    Updated,
    AlreadyInstalled,
}

enum InstallTargetSelection {
    Prompt,
    Selected(Vec<usize>),
}

pub fn install_skill(
    install_claude: bool,
    install_agents: bool,
    install_codex: bool,
) -> Result<(), Box<dyn Error>> {
    let selections = match resolve_install_target_selection(
        install_claude,
        install_agents,
        install_codex,
        interactive_terminal_available(),
    ) {
        InstallTargetSelection::Prompt => {
            let Some(selections) = prompt_for_install_targets()? else {
                eprintln!("Cancelled.");
                return Ok(());
            };

            selections
        }
        InstallTargetSelection::Selected(selections) => selections,
    };

    let home_dir =
        dirs::home_dir().ok_or("Could not determine the home directory for skill installation.")?;

    if selections.is_empty() {
        eprintln!("No install targets selected.");
        return Ok(());
    }

    for selection in selections {
        let target = &INSTALL_TARGETS[selection];
        let result = install_target(&home_dir, target)?;
        eprintln!("{}", narration_for_result(&result, target));
    }

    Ok(())
}

/// This is prose, not data — `install-skill` has no structured stdout
/// output, so all of it belongs on stderr (CLI-16). Split into a pure
/// function so the message text itself stays unit-testable without
/// capturing stderr.
fn narration_for_result(result: &SyncResult, target: &InstallTarget) -> String {
    match result {
        SyncResult::Installed => format!("Installed dev-browser skill to {}", target.file_display),
        SyncResult::Updated => format!("Updated dev-browser skill at {}", target.file_display),
        SyncResult::AlreadyInstalled => format!(
            "dev-browser skill is already installed at {}",
            target.file_display
        ),
    }
}

fn resolve_install_target_selection(
    install_claude: bool,
    install_agents: bool,
    install_codex: bool,
    interactive_terminal: bool,
) -> InstallTargetSelection {
    if install_claude || install_agents || install_codex {
        let mut selections = Vec::new();
        if install_claude {
            selections.push(0);
        }
        if install_agents {
            selections.push(1);
        }
        if install_codex {
            selections.push(2);
        }

        return InstallTargetSelection::Selected(selections);
    }

    if interactive_terminal {
        InstallTargetSelection::Prompt
    } else {
        InstallTargetSelection::Selected((0..INSTALL_TARGETS.len()).collect())
    }
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
                eprintln!("Created {display_path}");
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

#[cfg(test)]
mod tests {
    use super::{
        narration_for_result, resolve_install_target_selection, InstallTargetSelection,
        SyncResult, INSTALL_TARGETS,
    };

    #[test]
    fn explicit_claude_flag_skips_prompt() {
        let selection = resolve_install_target_selection(true, false, false, true);
        assert_selected(selection, &[0]);
    }

    #[test]
    fn explicit_agents_flag_skips_prompt() {
        let selection = resolve_install_target_selection(false, true, false, true);
        assert_selected(selection, &[1]);
    }

    #[test]
    fn explicit_codex_flag_skips_prompt() {
        let selection = resolve_install_target_selection(false, false, true, true);
        assert_selected(selection, &[2]);
    }

    #[test]
    fn explicit_flags_can_select_all_targets() {
        let selection = resolve_install_target_selection(true, true, true, false);
        assert_selected(selection, &[0, 1, 2]);
    }

    #[test]
    fn interactive_terminal_without_flags_prompts() {
        let selection = resolve_install_target_selection(false, false, false, true);
        assert!(matches!(selection, InstallTargetSelection::Prompt));
    }

    #[test]
    fn non_interactive_without_flags_defaults_to_all_targets() {
        let selection = resolve_install_target_selection(false, false, false, false);
        assert_selected(selection, &[0, 1, 2]);
    }

    fn assert_selected(selection: InstallTargetSelection, expected: &[usize]) {
        match selection {
            InstallTargetSelection::Prompt => panic!("expected explicit selection"),
            InstallTargetSelection::Selected(actual) => assert_eq!(actual, expected),
        }
    }

    // --- CLI-16: narration text (routing itself is exercised by hand: the
    // call sites use eprintln!, verified by inspection since println!/
    // eprintln! destinations aren't practically interceptable from a plain
    // unit test without a larger refactor to injectable writers). ----------

    #[test]
    fn narration_messages_reference_the_target_file_and_describe_the_outcome() {
        let target = &INSTALL_TARGETS[0];

        let installed = narration_for_result(&SyncResult::Installed, target);
        assert!(installed.contains(target.file_display));
        assert!(installed.starts_with("Installed"));

        let updated = narration_for_result(&SyncResult::Updated, target);
        assert!(updated.contains(target.file_display));
        assert!(updated.starts_with("Updated"));

        let already = narration_for_result(&SyncResult::AlreadyInstalled, target);
        assert!(already.contains(target.file_display));
        assert!(already.contains("already installed"));
    }
}

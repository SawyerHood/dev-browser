use serde::Deserialize;
use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::path::Path;

const MAX_SAFE_TIMEOUT_MS: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum IdleTimeoutValue {
    String(String),
    Milliseconds(u64),
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct UserConfig {
    idle_timeout: Option<IdleTimeoutValue>,
}

pub fn parse_idle_timeout(value: &str) -> Result<u64, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("idle timeout cannot be empty".to_string());
    }

    let (number, multiplier) = match value.as_bytes().last().copied() {
        Some(b's') => (&value[..value.len() - 1], 1_000_u64),
        Some(b'm') => (&value[..value.len() - 1], 60_000_u64),
        Some(b'h') => (&value[..value.len() - 1], 3_600_000_u64),
        Some(last) if last.is_ascii_alphabetic() => {
            return Err("invalid unit (use s, m, h, or raw milliseconds)".to_string());
        }
        _ => (value, 1_u64),
    };

    if number.is_empty() {
        return Err("idle timeout is missing a number".to_string());
    }

    let amount = number
        .parse::<u64>()
        .map_err(|_| "idle timeout must be a non-negative integer".to_string())?;
    let milliseconds = amount
        .checked_mul(multiplier)
        .ok_or_else(|| "idle timeout is too large".to_string())?;

    if milliseconds > MAX_SAFE_TIMEOUT_MS {
        return Err("idle timeout is too large".to_string());
    }

    Ok(milliseconds)
}

pub fn effective_idle_timeout_ms(cli_value: Option<u64>) -> Result<u64, Box<dyn Error>> {
    let config_path = dirs::home_dir().map(|home| home.join(".dev-browser").join("config.json"));
    resolve_idle_timeout(
        cli_value,
        env::var("DEV_BROWSER_IDLE_TIMEOUT_MS").ok().as_deref(),
        config_path.as_deref(),
    )
}

fn resolve_idle_timeout(
    cli_value: Option<u64>,
    environment_value: Option<&str>,
    config_path: Option<&Path>,
) -> Result<u64, Box<dyn Error>> {
    if let Some(milliseconds) = cli_value {
        return Ok(milliseconds);
    }

    if let Some(value) = environment_value {
        return parse_idle_timeout(value)
            .map_err(|error| format!("Invalid DEV_BROWSER_IDLE_TIMEOUT_MS: {error}").into());
    }

    let Some(config_path) = config_path else {
        return Ok(0);
    };

    let contents = match fs::read_to_string(config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    let config: UserConfig = serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid user config at {}: {error}", config_path.display()))?;

    match config.idle_timeout {
        Some(IdleTimeoutValue::String(value)) => parse_idle_timeout(&value).map_err(|error| {
            format!("Invalid idleTimeout in {}: {error}", config_path.display()).into()
        }),
        Some(IdleTimeoutValue::Milliseconds(milliseconds)) => {
            if milliseconds > MAX_SAFE_TIMEOUT_MS {
                Err(format!(
                    "Invalid idleTimeout in {}: idle timeout is too large",
                    config_path.display()
                )
                .into())
            } else {
                Ok(milliseconds)
            }
        }
        None => Ok(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config(contents: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!(
            "dev-browser-config-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn parses_human_friendly_and_raw_timeouts() {
        assert_eq!(parse_idle_timeout("30s").unwrap(), 30_000);
        assert_eq!(parse_idle_timeout("5m").unwrap(), 300_000);
        assert_eq!(parse_idle_timeout("1h").unwrap(), 3_600_000);
        assert_eq!(parse_idle_timeout("2500").unwrap(), 2_500);
        assert_eq!(parse_idle_timeout("0").unwrap(), 0);
    }

    #[test]
    fn rejects_invalid_timeouts() {
        assert!(parse_idle_timeout("").is_err());
        assert!(parse_idle_timeout("1d").is_err());
        assert!(parse_idle_timeout("1.5m").is_err());
        assert!(parse_idle_timeout("-1").is_err());
    }

    #[test]
    fn resolves_cli_then_environment_then_config_then_disabled() {
        let config_path = temp_config(r#"{"idleTimeout":"1h"}"#);

        assert_eq!(
            resolve_idle_timeout(Some(30_000), Some("5m"), Some(&config_path)).unwrap(),
            30_000
        );
        assert_eq!(
            resolve_idle_timeout(Some(0), Some("5m"), Some(&config_path)).unwrap(),
            0
        );
        assert_eq!(
            resolve_idle_timeout(None, Some("5m"), Some(&config_path)).unwrap(),
            300_000
        );
        assert_eq!(
            resolve_idle_timeout(None, None, Some(&config_path)).unwrap(),
            3_600_000
        );
        assert_eq!(resolve_idle_timeout(None, None, None).unwrap(), 0);

        fs::remove_dir_all(config_path.parent().unwrap()).unwrap();
    }

    #[test]
    fn accepts_numeric_config_and_zero_disables_cleanup() {
        let numeric_path = temp_config(r#"{"idleTimeout":45000}"#);
        assert_eq!(
            resolve_idle_timeout(None, None, Some(&numeric_path)).unwrap(),
            45_000
        );
        fs::remove_dir_all(numeric_path.parent().unwrap()).unwrap();

        let zero_path = temp_config(r#"{"idleTimeout":"0s"}"#);
        assert_eq!(
            resolve_idle_timeout(None, None, Some(&zero_path)).unwrap(),
            0
        );
        fs::remove_dir_all(zero_path.parent().unwrap()).unwrap();
    }
}

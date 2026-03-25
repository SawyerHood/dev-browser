use std::io::{self, BufRead, Write};

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Duration;

#[cfg(windows)]
use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream};

#[cfg(unix)]
pub type DaemonStream = UnixStream;
#[cfg(windows)]
pub type DaemonStream = Stream;

#[cfg(unix)]
pub fn socket_path() -> io::Result<PathBuf> {
    dirs::home_dir()
        .map(|path| path.join(".dev-browser").join("daemon.sock"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine home directory",
            )
        })
}

#[cfg(windows)]
fn sanitize_pipe_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '-',
        })
        .collect::<String>()
        .trim_matches('-')
        .to_ascii_lowercase();

    if sanitized.is_empty() {
        "user".to_string()
    } else {
        sanitized
    }
}

#[cfg(windows)]
fn daemon_pipe_name() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .and_then(|path| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| "user".to_string())
        });

    format!("dev-browser-daemon-{}", sanitize_pipe_segment(&user))
}

#[cfg(unix)]
pub fn connect_to_daemon() -> io::Result<DaemonStream> {
    let stream = DaemonStream::connect(socket_path()?)?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(stream)
}

#[cfg(windows)]
pub fn connect_to_daemon() -> io::Result<DaemonStream> {
    let name = daemon_pipe_name()
        .to_ns_name::<GenericNamespaced>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;

    DaemonStream::connect(name)
}

pub fn send_message<W: Write>(stream: &mut W, msg: &serde_json::Value) -> io::Result<()> {
    let json = serde_json::to_string(msg)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    stream.write_all(json.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub fn read_line<R: BufRead>(reader: &mut R) -> io::Result<String> {
    let mut line = String::new();
    let bytes_read = reader.read_line(&mut line)?;

    if bytes_read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Daemon connection closed unexpectedly",
        ));
    }

    Ok(line)
}

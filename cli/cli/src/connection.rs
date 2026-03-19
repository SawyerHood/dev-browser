use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

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

pub fn connect_to_daemon() -> io::Result<UnixStream> {
    let stream = UnixStream::connect(socket_path()?)?;
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(stream)
}

pub fn send_message(stream: &mut UnixStream, msg: &serde_json::Value) -> io::Result<()> {
    let json = serde_json::to_string(msg)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    stream.write_all(json.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub fn read_line(reader: &mut BufReader<UnixStream>) -> io::Result<String> {
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

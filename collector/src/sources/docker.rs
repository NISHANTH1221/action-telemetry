use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// Extracts (name, image) from a raw HTTP/1.0 response to GET /containers/{id}/json.
pub fn parse_inspect_response(raw: &[u8]) -> Option<(String, String)> {
    let text = std::str::from_utf8(raw).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    if head.lines().next()?.split_whitespace().nth(1)? != "200" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let name = v.get("Name")?.as_str()?.trim_start_matches('/').to_string();
    let image = v.get("Config")?.get("Image")?.as_str()?.to_string();
    Some((name, image))
}

/// One short request per newly seen container; HTTP/1.0 so the daemon closes the connection.
pub fn inspect(sock: &Path, id: &str, timeout: Duration) -> Option<(String, String)> {
    let mut s = UnixStream::connect(sock).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(
        s,
        "GET /containers/{}/json HTTP/1.0\r\nHost: docker\r\n\r\n",
        id
    )
    .ok()?;
    s.flush().ok()?;
    let mut buf = Vec::new();
    s.take(4 * 1024 * 1024).read_to_end(&mut buf).ok()?;
    parse_inspect_response(&buf)
}

pub fn socket_available(sock: &Path) -> bool {
    UnixStream::connect(sock).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    const OK: &[u8] = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"Name\":\"/db\",\"Config\":{\"Image\":\"postgres:16\"}}";

    #[test]
    fn parses_ok_response() {
        assert_eq!(
            parse_inspect_response(OK),
            Some(("db".into(), "postgres:16".into()))
        );
    }

    #[test]
    fn rejects_non_200_and_garbage() {
        assert_eq!(
            parse_inspect_response(b"HTTP/1.0 404 Not Found\r\n\r\n{\"message\":\"x\"}"),
            None
        );
        assert_eq!(parse_inspect_response(b"garbage"), None);
    }

    #[test]
    fn inspect_talks_http_over_unix_socket() {
        let sock = crate::test_temp("docker").join("d.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = conn.read(&mut buf).unwrap();
            conn.write_all(OK).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        let got = inspect(&sock, "abc", Duration::from_millis(500));
        let req = server.join().unwrap();
        assert!(
            req.starts_with("GET /containers/abc/json HTTP/1.0\r\n"),
            "{req}"
        );
        assert_eq!(got, Some(("db".into(), "postgres:16".into())));
    }

    #[test]
    fn missing_socket_is_none() {
        let p = Path::new("/definitely/not/here.sock");
        assert_eq!(inspect(p, "abc", Duration::from_millis(100)), None);
        assert!(!socket_available(p));
    }
}

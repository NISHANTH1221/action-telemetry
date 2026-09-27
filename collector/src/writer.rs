use crate::record::Record;
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

pub struct Writer {
    file: File,
    written: u64,
    lines: u64,
    max_bytes: u64,
}

impl Writer {
    pub fn create(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Writer {
            file: File::create(path)?,
            written: 0,
            lines: 0,
            max_bytes,
        })
    }

    /// One unbuffered write per line, so a crash can only truncate the last line.
    pub fn write(&mut self, rec: &Record) -> io::Result<()> {
        let mut line = serde_json::to_vec(rec).map_err(io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.written += line.len() as u64;
        self.lines += 1;
        if self.lines.is_multiple_of(64) {
            self.drop_cache();
        }
        Ok(())
    }

    /// 0 while under the cap, 1 once past it, 2 at twice the cap, and so on.
    pub fn cap_level(&self) -> u32 {
        self.written.checked_div(self.max_bytes).unwrap_or(0) as u32
    }

    /// Best effort: ask the kernel to drop our already-written pages from the page cache.
    #[cfg(target_os = "linux")]
    fn drop_cache(&self) {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::posix_fadvise(self.file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn drop_cache(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::Downsample;

    #[test]
    fn writes_one_json_line_per_record_and_tracks_cap_level() {
        let path = crate::test_temp("writer").join("nested/s.ndjson");
        let mut w = Writer::create(&path, 40).unwrap();
        assert_eq!(w.cap_level(), 0);
        for i in 0..2 {
            w.write(&Record::Downsample(Downsample {
                t: i as f64,
                interval: 2.0,
            }))
            .unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let v: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(v["type"], "downsample");
        assert!(
            w.cap_level() >= 1,
            "{} bytes over a 40-byte cap",
            text.len()
        );
    }
}

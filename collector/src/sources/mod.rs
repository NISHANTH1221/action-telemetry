pub mod cgroup;
pub mod cpu;
pub mod disk;
pub mod docker;
pub mod fs;
pub mod mem;
pub mod net;
pub mod procs;
pub mod psi;

use std::path::{Path, PathBuf};

/// Filesystem roots the collector reads from; swapped for fixtures in tests.
#[derive(Debug, Clone)]
pub struct Roots {
    pub proc: PathBuf,
    pub sys: PathBuf,
    pub docker_sock: PathBuf,
}

impl Roots {
    pub fn real() -> Self {
        Roots {
            proc: PathBuf::from("/proc"),
            sys: PathBuf::from("/sys"),
            docker_sock: PathBuf::from("/var/run/docker.sock"),
        }
    }
}

pub fn read(root: &Path, rel: &str) -> Option<String> {
    std::fs::read_to_string(root.join(rel)).ok()
}

/// Per-second rate between two cumulative counters; a counter reset yields 0.
pub fn rate(prev: u64, cur: u64, secs: f64) -> u64 {
    if cur < prev || secs <= 0.0 {
        return 0;
    }
    ((cur - prev) as f64 / secs).round() as u64
}

pub fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub fn clk_tck() -> f64 {
    let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if v > 0 {
        v as f64
    } else {
        100.0
    }
}

pub fn page_size() -> u64 {
    let v = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if v > 0 {
        v as u64
    } else {
        4096
    }
}

#[cfg(test)]
pub fn fixture_roots() -> Roots {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux");
    Roots {
        proc: base.join("proc"),
        sys: base.join("sys"),
        docker_sock: base.join("no-docker.sock"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_handles_normal_reset_and_zero_elapsed() {
        assert_eq!(rate(100, 300, 2.0), 100);
        assert_eq!(rate(300, 100, 1.0), 0);
        assert_eq!(rate(100, 300, 0.0), 0);
    }

    #[test]
    fn sysconf_values_are_sane() {
        assert!(clk_tck() >= 1.0);
        assert!(page_size() >= 4096);
    }
}

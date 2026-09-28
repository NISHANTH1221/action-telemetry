use crate::record::SelfStats;

/// The collector's own peak RSS and CPU time, for the report's overhead figures.
pub fn read() -> SelfStats {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } != 0 {
        return SelfStats::default();
    }
    let secs = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    // ru_maxrss survives execve on Linux, so it would include the spawning Node
    // process's RSS; VmHWM is this process image's own high-water mark.
    #[cfg(target_os = "linux")]
    let peak_rss = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| parse_vmhwm(&s))
        .unwrap_or(ru.ru_maxrss as u64 * 1024); // KiB on Linux
    #[cfg(not(target_os = "linux"))]
    let peak_rss = ru.ru_maxrss as u64; // bytes on macOS
    SelfStats {
        peak_rss,
        cpu_seconds: ((secs(ru.ru_utime) + secs(ru.ru_stime)) * 1000.0).round() / 1000.0,
    }
}

/// Parses the `VmHWM:` line of /proc/self/status (kB) into bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_vmhwm(status: &str) -> Option<u64> {
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kb: u64 = line["VmHWM:".len()..]
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    Some(kb * 1024)
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_nonzero_peak_rss() {
        let s = super::read();
        assert!(s.peak_rss > 0);
        assert!(s.cpu_seconds >= 0.0);
    }

    #[test]
    fn parses_vmhwm_in_bytes() {
        let status =
            "Name:\tcollector\nVmPeak:\t    9000 kB\nVmHWM:\t    1800 kB\nVmRSS:\t    1700 kB\n";
        assert_eq!(super::parse_vmhwm(status), Some(1_843_200));
        assert_eq!(
            super::parse_vmhwm("Name:\tcollector\nVmRSS:\t 1 kB\n"),
            None
        );
    }
}

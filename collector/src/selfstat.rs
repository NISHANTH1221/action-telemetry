use crate::record::SelfStats;

/// The collector's own peak RSS and CPU time, for the report's overhead figures.
pub fn read() -> SelfStats {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } != 0 {
        return SelfStats::default();
    }
    let secs = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    #[cfg(target_os = "linux")]
    let peak_rss = ru.ru_maxrss as u64 * 1024; // KiB on Linux
    #[cfg(not(target_os = "linux"))]
    let peak_rss = ru.ru_maxrss as u64; // bytes on macOS
    SelfStats {
        peak_rss,
        cpu_seconds: ((secs(ru.ru_utime) + secs(ru.ru_stime)) * 1000.0).round() / 1000.0,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_nonzero_peak_rss() {
        let s = super::read();
        assert!(s.peak_rss > 0);
        assert!(s.cpu_seconds >= 0.0);
    }
}

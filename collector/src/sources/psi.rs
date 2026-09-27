use crate::record::Psi;
use std::path::Path;

/// Returns (some avg10, full avg10) from a /proc/pressure/* file.
pub fn parse_pressure(s: &str) -> (Option<f64>, Option<f64>) {
    let (mut some, mut full) = (None, None);
    for line in s.lines() {
        let mut parts = line.split_whitespace();
        let kind = parts.next();
        let avg10 =
            parts.find_map(|p| p.strip_prefix("avg10=").and_then(|v| v.parse::<f64>().ok()));
        match kind {
            Some("some") => some = avg10,
            Some("full") => full = avg10,
            _ => {}
        }
    }
    (some, full)
}

/// None when the kernel has no PSI (no /proc/pressure/cpu).
pub fn read(proc_root: &Path) -> Option<Psi> {
    let cpu = super::read(proc_root, "pressure/cpu")?;
    let mem = super::read(proc_root, "pressure/memory").unwrap_or_default();
    let io = super::read(proc_root, "pressure/io").unwrap_or_default();
    let (cpu_some, _) = parse_pressure(&cpu);
    let (mem_some, mem_full) = parse_pressure(&mem);
    let (io_some, io_full) = parse_pressure(&io);
    Some(Psi {
        cpu_some,
        mem_some,
        mem_full,
        io_some,
        io_full,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::fixture_roots;

    #[test]
    fn parses_some_and_full_avg10() {
        let (some, full) = parse_pressure("some avg10=12.50 avg60=4.00 avg300=1.00 total=5\nfull avg10=8.25 avg60=0 avg300=0 total=2\n");
        assert_eq!(some, Some(12.5));
        assert_eq!(full, Some(8.25));
    }

    #[test]
    fn reads_all_three_files() {
        let p = read(&fixture_roots().proc).unwrap();
        assert_eq!(
            p,
            Psi {
                cpu_some: Some(3.1),
                mem_some: Some(12.5),
                mem_full: Some(8.25),
                io_some: Some(0.4),
                io_full: Some(0.1)
            }
        );
    }

    #[test]
    fn missing_psi_is_none() {
        assert!(read(Path::new("/definitely/not/here")).is_none());
    }
}

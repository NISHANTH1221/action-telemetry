use crate::record::Mem;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MemInfo {
    pub total: u64,
    pub available: u64,
    pub cached: u64,
    pub swap_total: u64,
    pub swap_free: u64,
}

pub fn parse_meminfo(s: &str) -> Option<MemInfo> {
    let mut m = MemInfo::default();
    let (mut seen_total, mut seen_avail) = (false, false);
    for line in s.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("");
        let Some(kb) = parts.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let bytes = kb * 1024;
        match key {
            "MemTotal:" => {
                m.total = bytes;
                seen_total = true;
            }
            "MemAvailable:" => {
                m.available = bytes;
                seen_avail = true;
            }
            "Cached:" => m.cached = bytes,
            "SwapTotal:" => m.swap_total = bytes,
            "SwapFree:" => m.swap_free = bytes,
            _ => {}
        }
    }
    (seen_total && seen_avail).then_some(m)
}

impl MemInfo {
    pub fn to_mem(&self) -> Mem {
        Mem {
            used: self.total.saturating_sub(self.available),
            avail: self.available,
            cached: self.cached,
            swap: self.swap_total.saturating_sub(self.swap_free),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MEMINFO: &str = include_str!("../../tests/fixtures/linux/proc/meminfo");

    #[test]
    fn parses_meminfo_in_bytes() {
        let m = parse_meminfo(MEMINFO).unwrap();
        assert_eq!(m.total, 2035000 * 1024);
        assert_eq!(m.available, 1160000 * 1024);
        assert_eq!(m.cached, 390000 * 1024);
        assert_eq!(m.swap_total, 1048572 * 1024);
    }

    #[test]
    fn converts_to_record() {
        let mem = parse_meminfo(MEMINFO).unwrap().to_mem();
        assert_eq!(mem.used, 875000 * 1024);
        assert_eq!(mem.avail, 1160000 * 1024);
        assert_eq!(mem.swap, 0);
    }

    #[test]
    fn requires_total_and_available() {
        assert!(parse_meminfo("MemTotal: 10 kB\n").is_none());
    }
}

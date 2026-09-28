use super::round1;
use crate::record::CpuPct;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuTimes {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

impl CpuTimes {
    pub fn total(&self) -> u64 {
        self.user
            + self.nice
            + self.system
            + self.idle
            + self.iowait
            + self.irq
            + self.softirq
            + self.steal
    }
}

/// Parses the aggregate `cpu ` line of /proc/stat.
pub fn parse_stat(s: &str) -> Option<CpuTimes> {
    let line = s.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|x| x.parse().unwrap_or(0))
        .collect();
    if v.len() < 8 {
        return None;
    }
    Some(CpuTimes {
        user: v[0],
        nice: v[1],
        system: v[2],
        idle: v[3],
        iowait: v[4],
        irq: v[5],
        softirq: v[6],
        steal: v[7],
    })
}

pub fn count_cpus(s: &str) -> u32 {
    s.lines()
        .filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(|b| b.is_ascii_digit()))
        .count() as u32
}

/// Percent of all CPU time between two readings. usr includes nice; sys includes irq+softirq.
pub fn pct(prev: &CpuTimes, cur: &CpuTimes) -> CpuPct {
    let total = cur.total().saturating_sub(prev.total());
    if total == 0 {
        return CpuPct::default();
    }
    let d = |a: u64, b: u64| round1(b.saturating_sub(a) as f64 * 100.0 / total as f64);
    CpuPct {
        usr: d(prev.user + prev.nice, cur.user + cur.nice),
        sys: d(
            prev.system + prev.irq + prev.softirq,
            cur.system + cur.irq + cur.softirq,
        ),
        iow: d(prev.iowait, cur.iowait),
        steal: d(prev.steal, cur.steal),
    }
}

pub fn parse_loadavg(s: &str) -> Option<f64> {
    s.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    const STAT: &str = include_str!("../../tests/fixtures/linux/proc/stat");

    #[test]
    fn parses_aggregate_cpu_line() {
        let t = parse_stat(STAT).unwrap();
        assert_eq!(t.user, 10132153);
        assert_eq!(t.nice, 290696);
        assert_eq!(t.system, 3084719);
        assert_eq!(t.idle, 46828483);
        assert_eq!(t.iowait, 16683);
        assert_eq!(t.softirq, 25195);
        assert_eq!(t.steal, 0);
    }

    #[test]
    fn counts_per_cpu_lines() {
        assert_eq!(count_cpus(STAT), 2);
    }

    #[test]
    fn pct_splits_deltas() {
        let prev = CpuTimes {
            user: 100,
            idle: 100,
            ..Default::default()
        };
        let cur = CpuTimes {
            user: 140,
            nice: 10,
            system: 20,
            idle: 110,
            iowait: 10,
            steal: 10,
            ..Default::default()
        };
        // total delta = 50+20+10+10+10 = 100
        let p = pct(&prev, &cur);
        assert_eq!(
            p,
            CpuPct {
                usr: 50.0,
                sys: 20.0,
                iow: 10.0,
                steal: 10.0
            }
        );
    }

    #[test]
    fn pct_is_zero_when_no_time_passed() {
        let t = CpuTimes {
            user: 5,
            ..Default::default()
        };
        assert_eq!(pct(&t, &t), CpuPct::default());
    }

    #[test]
    fn parses_loadavg_and_rejects_garbage() {
        assert_eq!(parse_loadavg("0.92 0.71 0.60 2/345 12345"), Some(0.92));
        assert_eq!(parse_loadavg(""), None);
        assert!(parse_stat("intr 1 2 3").is_none());
    }
}

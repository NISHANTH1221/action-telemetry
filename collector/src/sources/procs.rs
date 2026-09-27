use super::round1;
use crate::record::{ProcEntry, Procs};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct PidStat {
    pub pid: i32,
    pub comm: String,
    pub ticks: u64,
    pub rss_pages: u64,
}

/// Parses /proc/[pid]/stat. comm may contain spaces and ')' so we split on the last ')'.
pub fn parse_pid_stat(s: &str) -> Option<PidStat> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    let pid = s[..open].trim().parse().ok()?;
    let comm = s[open + 1..close].to_string();
    let rest: Vec<&str> = s[close + 1..].split_whitespace().collect();
    let num = |i: usize| rest.get(i).and_then(|v| v.parse::<u64>().ok());
    // rest[0] is field 3 (state): utime=14, stime=15, rss=24 → indices 11, 12, 21
    Some(PidStat {
        pid,
        comm,
        ticks: num(11)? + num(12)?,
        rss_pages: num(21)?,
    })
}

pub fn top_n(mut entries: Vec<ProcEntry>, n: usize) -> Procs {
    entries.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(a.pid.cmp(&b.pid)));
    let cpu = entries
        .iter()
        .filter(|e| e.cpu > 0.0)
        .take(n)
        .cloned()
        .collect();
    entries.sort_by(|a, b| b.rss.cmp(&a.rss).then(a.pid.cmp(&b.pid)));
    let rss = entries.iter().take(n).cloned().collect();
    Procs { cpu, rss }
}

pub struct ProcSampler {
    prev: HashMap<i32, u64>,
    clk_tck: f64,
    page_size: u64,
}

impl ProcSampler {
    pub fn new(clk_tck: f64, page_size: u64) -> Self {
        ProcSampler {
            prev: HashMap::new(),
            clk_tck,
            page_size,
        }
    }

    /// Top 5 by CPU (% of one core since the previous call) and by RSS.
    pub fn sample(&mut self, proc_root: &Path, elapsed_secs: f64) -> Procs {
        let mut entries = Vec::new();
        let mut next = HashMap::new();
        if let Ok(dir) = std::fs::read_dir(proc_root) {
            for ent in dir.flatten() {
                let Some(pid) = ent.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else {
                    continue;
                };
                let Ok(s) = std::fs::read_to_string(ent.path().join("stat")) else {
                    continue;
                };
                let Some(st) = parse_pid_stat(&s) else {
                    continue;
                };
                let cpu = match self.prev.get(&pid) {
                    Some(&p) if elapsed_secs > 0.0 => round1(
                        st.ticks.saturating_sub(p) as f64 / self.clk_tck / elapsed_secs * 100.0,
                    ),
                    _ => 0.0,
                };
                next.insert(pid, st.ticks);
                entries.push(ProcEntry {
                    pid,
                    comm: st.comm,
                    cpu,
                    rss: st.rss_pages * self.page_size,
                });
            }
        }
        self.prev = next;
        top_n(entries, 5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::fixture_roots;

    fn e(pid: i32, cpu: f64, rss: u64) -> ProcEntry {
        ProcEntry {
            pid,
            comm: format!("p{pid}"),
            cpu,
            rss,
        }
    }

    #[test]
    fn parses_stat_with_spaces_in_comm() {
        let s = std::fs::read_to_string(fixture_roots().proc.join("4242/stat")).unwrap();
        let p = parse_pid_stat(&s).unwrap();
        assert_eq!(
            p,
            PidStat {
                pid: 4242,
                comm: "node server".into(),
                ticks: 1800,
                rss_pages: 51200
            }
        );
    }

    #[test]
    fn parses_comm_containing_parentheses() {
        let p = parse_pid_stat("7 (a) b) R 1 1 1 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 1 1 3").unwrap();
        assert_eq!(p.comm, "a) b");
        assert_eq!(p.ticks, 15);
        assert_eq!(p.rss_pages, 3);
    }

    #[test]
    fn top_n_orders_and_drops_idle_from_cpu_list() {
        let t = top_n(vec![e(1, 0.0, 900), e(2, 50.0, 100), e(3, 10.0, 500)], 2);
        assert_eq!(t.cpu.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(t.rss.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![1, 3]);
    }

    #[test]
    fn first_sample_reports_zero_cpu_then_deltas() {
        let root = fixture_roots().proc;
        let mut s = ProcSampler::new(100.0, 4096);
        let first = s.sample(&root, 0.0);
        assert_eq!(first.rss[0].pid, 4242);
        assert_eq!(first.rss[0].rss, 51200 * 4096);
        assert!(first.cpu.is_empty());

        s.prev.insert(4242, 1700); // pretend 100 ticks were used over the last second
        let second = s.sample(&root, 1.0);
        assert_eq!(second.cpu[0].cpu, 100.0);
    }
}

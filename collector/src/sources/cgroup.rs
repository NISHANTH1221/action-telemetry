use super::{rate, round1};
use crate::record::Ctr;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn detect_version(sys_root: &Path) -> &'static str {
    let cg = sys_root.join("fs/cgroup");
    if cg.join("cgroup.controllers").exists() {
        "v2"
    } else if cg.join("memory").is_dir() {
        "v1"
    } else {
        "none"
    }
}

fn is_container_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Docker container cgroups under the systemd driver (system.slice/docker-<id>.scope)
/// and the cgroupfs driver (docker/<id>).
pub fn list_docker_cgroups(sys_root: &Path) -> Vec<(String, PathBuf)> {
    let cg = sys_root.join("fs/cgroup");
    let mut out = Vec::new();
    if let Ok(dir) = std::fs::read_dir(cg.join("system.slice")) {
        for e in dir.flatten() {
            let name = e.file_name();
            let id = name
                .to_str()
                .and_then(|n| n.strip_prefix("docker-"))
                .and_then(|n| n.strip_suffix(".scope"));
            if let Some(id) = id.filter(|id| is_container_id(id)) {
                out.push((id.to_string(), e.path()));
            }
        }
    }
    if let Ok(dir) = std::fs::read_dir(cg.join("docker")) {
        for e in dir.flatten() {
            if let Some(id) = e.file_name().to_str().filter(|id| is_container_id(id)) {
                out.push((id.to_string(), e.path()));
            }
        }
    }
    out.sort();
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CgroupCounters {
    pub usage_usec: u64,
    pub mem: u64,
    pub mem_peak: Option<u64>,
    pub rbytes: u64,
    pub wbytes: u64,
    pub oom_kills: u64,
}

pub fn parse_kv(s: &str, key: &str) -> Option<u64> {
    s.lines().find_map(|l| {
        let mut p = l.split_whitespace();
        if p.next()? == key {
            p.next()?.parse().ok()
        } else {
            None
        }
    })
}

pub fn parse_io_stat(s: &str) -> (u64, u64) {
    let (mut r, mut w) = (0, 0);
    for tok in s.split_whitespace() {
        if let Some(v) = tok.strip_prefix("rbytes=") {
            r += v.parse::<u64>().unwrap_or(0);
        } else if let Some(v) = tok.strip_prefix("wbytes=") {
            w += v.parse::<u64>().unwrap_or(0);
        }
    }
    (r, w)
}

/// None if the cgroup vanished (container exited between listing and reading).
pub fn read_counters(dir: &Path) -> Option<CgroupCounters> {
    let rd = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
    let cpu = rd("cpu.stat")?;
    let (rbytes, wbytes) = rd("io.stat").map(|s| parse_io_stat(&s)).unwrap_or((0, 0));
    Some(CgroupCounters {
        usage_usec: parse_kv(&cpu, "usage_usec").unwrap_or(0),
        mem: rd("memory.current")
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0),
        mem_peak: rd("memory.peak").and_then(|s| s.trim().parse().ok()),
        rbytes,
        wbytes,
        oom_kills: rd("memory.events")
            .and_then(|s| parse_kv(&s, "oom_kill"))
            .unwrap_or(0),
    })
}

#[derive(Default)]
pub struct CtrSampler {
    prev: HashMap<String, CgroupCounters>,
}

impl CtrSampler {
    /// Returns one Ctr per live container, plus the ids seen for the first time.
    pub fn sample(&mut self, sys_root: &Path, elapsed_secs: f64) -> (Vec<Ctr>, Vec<String>) {
        let (mut out, mut new_ids, mut next) = (Vec::new(), Vec::new(), HashMap::new());
        for (id, dir) in list_docker_cgroups(sys_root) {
            let Some(c) = read_counters(&dir) else {
                continue;
            };
            let (cpu, io_rd, io_wr) = match self.prev.get(&id) {
                Some(p) if elapsed_secs > 0.0 => (
                    round1(
                        c.usage_usec.saturating_sub(p.usage_usec) as f64 / 1e6 / elapsed_secs
                            * 100.0,
                    ),
                    rate(p.rbytes, c.rbytes, elapsed_secs),
                    rate(p.wbytes, c.wbytes, elapsed_secs),
                ),
                Some(_) => (0.0, 0, 0),
                None => {
                    new_ids.push(id.clone());
                    (0.0, 0, 0)
                }
            };
            out.push(Ctr {
                id: id.clone(),
                cpu,
                mem: c.mem,
                mem_peak: c.mem_peak,
                io_rd,
                io_wr,
                oom_kills: c.oom_kills,
            });
            next.insert(id, c);
        }
        self.prev = next;
        (out, new_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::fixture_roots;
    const ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn detects_v2_and_none() {
        assert_eq!(detect_version(&fixture_roots().sys), "v2");
        assert_eq!(detect_version(Path::new("/definitely/not/here")), "none");
    }

    #[test]
    fn lists_only_real_docker_scopes() {
        let ids: Vec<String> = list_docker_cgroups(&fixture_roots().sys)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(ids, vec![ID.to_string()]);
    }

    #[test]
    fn reads_counters() {
        let (_, dir) = list_docker_cgroups(&fixture_roots().sys).remove(0);
        let c = read_counters(&dir).unwrap();
        assert_eq!(
            c,
            CgroupCounters {
                usage_usec: 2_000_000,
                mem: 90_000_000,
                mem_peak: Some(95_000_000),
                rbytes: 4096,
                wbytes: 12288,
                oom_kills: 1
            }
        );
    }

    #[test]
    fn vanished_cgroup_is_none() {
        assert!(read_counters(Path::new("/definitely/not/here")).is_none());
    }

    #[test]
    fn sampler_reports_new_ids_then_rates() {
        let sys = fixture_roots().sys;
        let mut s = CtrSampler::default();
        let (first, new_ids) = s.sample(&sys, 0.0);
        assert_eq!(new_ids, vec![ID.to_string()]);
        assert_eq!(first[0].cpu, 0.0);
        assert_eq!(first[0].mem, 90_000_000);
        assert_eq!(first[0].oom_kills, 1);

        s.prev.get_mut(ID).unwrap().usage_usec = 1_000_000;
        s.prev.get_mut(ID).unwrap().wbytes = 2288;
        let (second, new_ids) = s.sample(&sys, 1.0);
        assert!(new_ids.is_empty());
        assert_eq!(second[0].cpu, 100.0);
        assert_eq!(second[0].io_wr, 10_000);
    }
}

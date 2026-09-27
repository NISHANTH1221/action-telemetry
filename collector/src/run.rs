use crate::cli::Config;
use crate::record::*;
use crate::sources::{self, cgroup, cpu, disk, docker, fs, mem, net, procs, psi, Roots};
use crate::writer::Writer;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EndReason {
    Sigterm,
    WatchPidGone,
    MaxDuration,
}

impl EndReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            EndReason::Sigterm => "sigterm",
            EndReason::WatchPidGone => "watch-pid-gone",
            EndReason::MaxDuration => "max-duration",
        }
    }
}

const FS_EVERY: Duration = Duration::from_secs(10);
const CTR_EVERY: Duration = Duration::from_secs(2);
const DUE_SLACK: Duration = Duration::from_millis(100);
const SLEEP_SLICE: Duration = Duration::from_millis(100);
const INSPECT_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Default)]
struct HostCounters {
    cpu: Option<cpu::CpuTimes>,
    disk: Option<(u64, u64)>,
    net: Option<(u64, u64)>,
}

fn read_host_counters(roots: &Roots) -> HostCounters {
    HostCounters {
        cpu: sources::read(&roots.proc, "stat").and_then(|s| cpu::parse_stat(&s)),
        disk: disk::read(roots),
        net: sources::read(&roots.proc, "net/dev").map(|s| net::parse_net_dev(&s)),
    }
}

/// Some(seconds since the previous run, 0 on the first) when a sub-sampler is due.
fn due(last: &mut Option<Instant>, every: Duration, now: Instant) -> Option<f64> {
    match *last {
        Some(t) if now.duration_since(t) + DUE_SLACK < every => None,
        prev => {
            *last = Some(now);
            Some(
                prev.map(|t| now.duration_since(t).as_secs_f64())
                    .unwrap_or(0.0),
            )
        }
    }
}

/// Sleeps `d` in short slices so SIGTERM is honoured quickly; true if asked to stop.
fn sleep_or_stop(d: Duration, stop: &AtomicBool) -> bool {
    let end = Instant::now() + d;
    loop {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        let now = Instant::now();
        if now >= end {
            return false;
        }
        std::thread::sleep((end - now).min(SLEEP_SLICE));
    }
}

fn uname() -> (String, String) {
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut u) } != 0 {
        return (String::new(), String::new());
    }
    let s = |f: &[libc::c_char]| {
        unsafe { std::ffi::CStr::from_ptr(f.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    };
    (s(&u.release), s(&u.machine))
}

pub fn run(cfg: &Config, roots: &Roots, stop: &AtomicBool) -> std::io::Result<EndReason> {
    let started = Instant::now();
    let mut w = Writer::create(&cfg.out, cfg.max_bytes)?;

    let stat = sources::read(&roots.proc, "stat").unwrap_or_default();
    let meminfo = sources::read(&roots.proc, "meminfo").and_then(|s| mem::parse_meminfo(&s));
    let cgroup_version = cgroup::detect_version(&roots.sys);
    let caps = Capabilities {
        psi: psi::read(&roots.proc).is_some(),
        docker_cgroups: cfg.docker && cgroup_version == "v2",
        docker_socket: cfg.docker && docker::socket_available(&roots.docker_sock),
    };
    let (kernel, arch) = uname();
    w.write(&Record::Meta(Meta {
        v: 1,
        t: now_secs(),
        interval: cfg.interval.as_secs_f64(),
        cpus: cpu::count_cpus(&stat),
        mem_total: meminfo.map(|m| m.total).unwrap_or(0),
        kernel,
        arch,
        cgroup: cgroup_version.to_string(),
        capabilities: caps,
    }))?;

    let mut prev = read_host_counters(roots);
    let mut prev_at = Instant::now();
    let mut interval = cfg.interval;
    let mut level = 0;
    let (mut last_fs, mut last_procs, mut last_ctr) = (None, None, None);
    let mut proc_sampler = procs::ProcSampler::new(sources::clk_tck(), sources::page_size());
    let mut ctr_sampler = cgroup::CtrSampler::default();

    let reason = loop {
        if sleep_or_stop(interval, stop) {
            break EndReason::Sigterm;
        }
        if let Some(pid) = cfg.watch_pid {
            if !roots.proc.join(pid.to_string()).exists() {
                break EndReason::WatchPidGone;
            }
        }
        if started.elapsed() >= cfg.max_duration {
            break EndReason::MaxDuration;
        }

        let now = Instant::now();
        let secs = now.duration_since(prev_at).as_secs_f64();
        let cur = read_host_counters(roots);
        let cpu_pct = match (&prev.cpu, &cur.cpu) {
            (Some(a), Some(b)) => cpu::pct(a, b),
            _ => CpuPct::default(),
        };
        let disk_rate = match (prev.disk, cur.disk) {
            (Some(a), Some(b)) => Disk {
                rd: sources::rate(a.0, b.0, secs),
                wr: sources::rate(a.1, b.1, secs),
            },
            _ => Disk::default(),
        };
        let net_rate = match (prev.net, cur.net) {
            (Some(a), Some(b)) => Net {
                rx: sources::rate(a.0, b.0, secs),
                tx: sources::rate(a.1, b.1, secs),
            },
            _ => Net::default(),
        };
        let fs_rec = due(&mut last_fs, FS_EVERY, now).map(|_| Fs {
            root_free: fs::free_bytes(Path::new("/")),
            ws_free: cfg.workspace.as_deref().and_then(fs::free_bytes),
        });
        let procs_rec = cfg
            .proc_interval
            .and_then(|every| due(&mut last_procs, every, now))
            .map(|e| proc_sampler.sample(&roots.proc, e));
        let mut new_ids = Vec::new();
        let ctr_rec = if caps.docker_cgroups {
            due(&mut last_ctr, CTR_EVERY, now).map(|e| {
                let (ctrs, ids) = ctr_sampler.sample(&roots.sys, e);
                new_ids = ids;
                ctrs
            })
        } else {
            None
        };

        w.write(&Record::Sample(Sample {
            t: now_secs(),
            cpu: cpu_pct,
            load1: sources::read(&roots.proc, "loadavg")
                .and_then(|s| cpu::parse_loadavg(&s))
                .unwrap_or(0.0),
            mem: meminfo_now(roots),
            psi: if caps.psi {
                psi::read(&roots.proc)
            } else {
                None
            },
            disk: disk_rate,
            net: net_rate,
            fs: fs_rec,
            procs: procs_rec,
            ctr: ctr_rec,
        }))?;

        if caps.docker_socket {
            for id in new_ids {
                if let Some((name, image)) =
                    docker::inspect(&roots.docker_sock, &id, INSPECT_TIMEOUT)
                {
                    w.write(&Record::Container(ContainerInfo {
                        t: now_secs(),
                        id,
                        name,
                        image,
                    }))?;
                }
            }
        }

        prev = cur;
        prev_at = now;
        let new_level = w.cap_level();
        if new_level > level {
            level = new_level;
            interval = cfg.interval * 2u32.pow(level.min(10));
            w.write(&Record::Downsample(Downsample {
                t: now_secs(),
                interval: interval.as_secs_f64(),
            }))?;
        }
    };

    w.write(&Record::End(End {
        t: now_secs(),
        reason: reason.as_str(),
        self_stats: crate::selfstat::read(),
    }))?;
    Ok(reason)
}

fn meminfo_now(roots: &Roots) -> Mem {
    sources::read(&roots.proc, "meminfo")
        .and_then(|s| mem::parse_meminfo(&s))
        .map(|m| m.to_mem())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::DEFAULT_MAX_BYTES;
    use crate::sources::fixture_roots;
    use std::path::PathBuf;

    const ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn cfg(out: PathBuf) -> Config {
        Config {
            out,
            interval: Duration::from_millis(50),
            proc_interval: Some(Duration::from_millis(50)),
            docker: true,
            watch_pid: None,
            max_bytes: DEFAULT_MAX_BYTES,
            max_duration: Duration::from_secs(60),
            workspace: None,
        }
    }

    fn lines(p: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(p)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn run_for(c: &Config, ms: u64) -> EndReason {
        let stop = AtomicBool::new(false);
        std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(ms));
                stop.store(true, Ordering::Relaxed);
            });
            run(c, &fixture_roots(), &stop).unwrap()
        })
    }

    #[test]
    fn writes_meta_samples_and_end_on_stop() {
        let out = crate::test_temp("run").join("s.ndjson");
        assert_eq!(run_for(&cfg(out.clone()), 400), EndReason::Sigterm);
        let recs = lines(&out);
        assert_eq!(recs[0]["type"], "meta");
        assert_eq!(recs[0]["cgroup"], "v2");
        assert_eq!(recs[0]["cpus"], 2);
        assert_eq!(recs[0]["capabilities"]["psi"], true);
        assert_eq!(recs[0]["capabilities"]["docker_cgroups"], true);
        assert_eq!(recs[0]["capabilities"]["docker_socket"], false);
        let samples: Vec<_> = recs.iter().filter(|r| r["type"] == "sample").collect();
        assert!(samples.len() >= 2, "got {} samples", samples.len());
        assert_eq!(samples[0]["psi"]["mem_full"], 8.25);
        assert_eq!(samples[0]["ctr"][0]["id"], ID);
        assert_eq!(samples[0]["procs"]["rss"][0]["pid"], 4242);
        assert!(samples[0]["fs"]["root_free"].as_u64().unwrap() > 0);
        let end = recs.last().unwrap();
        assert_eq!(end["type"], "end");
        assert_eq!(end["reason"], "sigterm");
        assert!(end["self"]["peak_rss"].as_u64().unwrap() > 0);
    }

    #[test]
    fn exits_when_watched_pid_is_gone() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config {
            watch_pid: Some(999_999),
            ..cfg(out.clone())
        };
        assert_eq!(run_for(&c, 5_000), EndReason::WatchPidGone);
        assert_eq!(lines(&out).last().unwrap()["reason"], "watch-pid-gone");
    }

    #[test]
    fn exits_at_max_duration_while_watched_pid_lives() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config {
            watch_pid: Some(4242),
            max_duration: Duration::from_millis(200),
            ..cfg(out)
        };
        assert_eq!(run_for(&c, 5_000), EndReason::MaxDuration);
    }

    #[test]
    fn downsamples_after_cap() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config {
            max_bytes: 200,
            ..cfg(out.clone())
        };
        run_for(&c, 300);
        let ds: Vec<_> = lines(&out)
            .into_iter()
            .filter(|r| r["type"] == "downsample")
            .collect();
        assert!(!ds.is_empty());
        assert!(ds[0]["interval"].as_f64().unwrap() > 0.05);
    }

    #[test]
    fn docker_disabled_omits_container_sampling() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config {
            docker: false,
            ..cfg(out.clone())
        };
        run_for(&c, 200);
        let recs = lines(&out);
        assert_eq!(recs[0]["capabilities"]["docker_cgroups"], false);
        assert!(recs
            .iter()
            .filter(|r| r["type"] == "sample")
            .all(|r| r.get("ctr").is_none()));
    }
}

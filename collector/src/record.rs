use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuPct {
    pub usr: f64,
    pub sys: f64,
    pub iow: f64,
    pub steal: f64,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Mem {
    pub used: u64,
    pub avail: u64,
    pub cached: u64,
    pub swap: u64,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Psi {
    pub cpu_some: Option<f64>,
    pub mem_some: Option<f64>,
    pub mem_full: Option<f64>,
    pub io_some: Option<f64>,
    pub io_full: Option<f64>,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Disk {
    pub rd: u64,
    pub wr: u64,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Net {
    pub rx: u64,
    pub tx: u64,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Fs {
    pub root_free: Option<u64>,
    pub ws_free: Option<u64>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ProcEntry {
    pub pid: i32,
    pub comm: String,
    pub cpu: f64,
    pub rss: u64,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Procs {
    pub cpu: Vec<ProcEntry>,
    pub rss: Vec<ProcEntry>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Ctr {
    pub id: String,
    pub cpu: f64,
    pub mem: u64,
    pub mem_peak: Option<u64>,
    pub io_rd: u64,
    pub io_wr: u64,
    pub oom_kills: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Sample {
    pub t: f64,
    pub cpu: CpuPct,
    pub load1: f64,
    pub mem: Mem,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub psi: Option<Psi>,
    pub disk: Disk,
    pub net: Net,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs: Option<Fs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procs: Option<Procs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctr: Option<Vec<Ctr>>,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Capabilities {
    pub psi: bool,
    pub docker_cgroups: bool,
    pub docker_socket: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Meta {
    pub v: u32,
    pub t: f64,
    pub interval: f64,
    pub cpus: u32,
    pub mem_total: u64,
    pub kernel: String,
    pub arch: String,
    pub cgroup: String,
    pub capabilities: Capabilities,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ContainerInfo {
    pub t: f64,
    pub id: String,
    pub name: String,
    pub image: String,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Downsample {
    pub t: f64,
    pub interval: f64,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct SelfStats {
    pub peak_rss: u64,
    pub cpu_seconds: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct End {
    pub t: f64,
    pub reason: &'static str,
    #[serde(rename = "self")]
    pub self_stats: SelfStats,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Record {
    Meta(Meta),
    Sample(Sample),
    Container(ContainerInfo),
    Downsample(Downsample),
    End(End),
}

/// Wall-clock seconds since the Unix epoch, millisecond precision.
pub fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64 / 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_is_tagged_and_omits_absent_groups() {
        let s = Sample {
            t: 1.5,
            cpu: CpuPct::default(),
            load1: 0.0,
            mem: Mem::default(),
            psi: None,
            disk: Disk::default(),
            net: Net::default(),
            fs: None,
            procs: None,
            ctr: None,
        };
        let v: serde_json::Value = serde_json::to_value(Record::Sample(s)).unwrap();
        assert_eq!(v["type"], "sample");
        assert_eq!(v["t"], 1.5);
        assert!(v.get("psi").is_none());
        assert!(v.get("ctr").is_none());
    }

    #[test]
    fn end_record_uses_self_key() {
        let e = End {
            t: 2.0,
            reason: "sigterm",
            self_stats: SelfStats {
                peak_rss: 10,
                cpu_seconds: 0.5,
            },
        };
        let v: serde_json::Value = serde_json::to_value(Record::End(e)).unwrap();
        assert_eq!(v["type"], "end");
        assert_eq!(v["reason"], "sigterm");
        assert_eq!(v["self"]["peak_rss"], 10);
    }

    #[test]
    fn now_secs_is_recent() {
        assert!(now_secs() > 1_700_000_000.0);
    }
}

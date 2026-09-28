# ci-telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public GitHub Marketplace action that records per-step CPU, memory, pressure, disk, network and Docker-container telemetry for a CI job with a sub-5 MB background collector, and uploads a JSON/HTML report as an artifact at job end.

**Architecture:** A JavaScript action (`node24`) whose `main` entry spawns a detached, low-priority Rust collector binary. The collector appends NDJSON samples read from `/proc` and cgroup v2 files. The automatic `post` entry stops the collector, fetches step timings with one GitHub API call, scans `dmesg` for OOM kills, builds `report.json`, `report.html` and the job summary, and uploads everything with `@actions/artifact`. The NDJSON file is the only interface between the Rust and TypeScript halves.

**Tech Stack:** Rust 2021 (`libc`, `serde`, `serde_json`, `signal-hook`; static musl builds); TypeScript 5, Node 24, `@actions/core` 1.x, `@actions/artifact` 2.x, `@vercel/ncc`, Vitest, Ajv (tests only).

**Spec:** `docs/superpowers/specs/2026-09-28-ci-telemetry-design.md`

### Clarifications to the spec made while planning (small, deliberate)

- The collector gets one extra flag, `--workspace <path>`, instead of reading `GITHUB_WORKSPACE` itself. This keeps it testable.
- Process RSS is read from field 24 of `/proc/[pid]/stat` rather than from `statm`, so each process costs one file read instead of two. The collector's own `peak_rss` and `cpu_seconds` come from `getrusage` instead of `/proc/self`.
- CPU % for top processes and for containers is **% of one core** (the `top` convention). Host CPU is % of all cores. The collector's `avg_cpu_pct` is % of one core, the stricter reading of the 0.5% budget.
- Report assembly lives in `src/report.ts`. The bundled entry points are `src/entry/{main,post}.ts`, which are thin wrappers around the testable `runMain` and `runPost`.
- The release commit that adds the binaries is reachable **only from tags**, so `main` never carries binaries.
- Summary tests use explicit string assertions instead of snapshot files.
- **No action outputs.** The spec listed `artifact-id`, `artifact-url` and `report-path`, but outputs set in a `post` step have no later step that can read them. `post` logs the artifact name and URL instead.
- **The HTML report follows the taste skill's `minimalist-ui` rules** (installed via `npx skills add Leonxlnx/taste-skill` into `.claude/skills/`), adapted to an offline single file: system fonts, no external assets, and a warm dark mode. The Markdown job summary keeps its emoji status markers, because GitHub's summary has no other way to show an icon. See Task 16.

## Global Constraints

- Action runtime: `runs.using: node24`; `main: dist/main/index.js`; `post: dist/post/index.js`; `post-if: always()`.
- Collector targets: `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`. Binaries are named `collector-linux-x64` and `collector-linux-arm64` and live in `dist/bin/`.
- Supported OS: Linux only. Any other platform or architecture → one `core.notice` and a no-op. It must never fail.
- **The action must never fail the user's job:** every error goes through `core.warning`, and no code path may call `core.setFailed` or exit with a non-zero code.
- No network calls while the user's steps run. The only calls are the Docker socket name lookup (a local Unix socket) and, in `post`, the GitHub API and the artifact upload.
- Collector: `nice 19`, `oom_score_adj 1000`, no child processes, data cap 50 MiB (`52428800` bytes) with the interval doubling at each multiple of the cap, watchdog on the `Runner.Worker` PID, hard stop after `72h`.
- Collector budget on a 5-minute workload: **peak RSS ≤ 5 MB, average CPU ≤ 0.5% of one core** (enforced in e2e).
- Input defaults: `interval` 1 (range 1–60), `process-interval` 5 (0–300, 0 disables), `docker` true, `github-token` `${{ github.token }}`, `artifact-name` `''` (auto), `retention-days` 7 (1–90), `job-summary` true, `html-report` true.
- Default artifact name: `ci-telemetry-${GITHUB_JOB}-${GITHUB_RUN_ATTEMPT}-${first 6 hex of sha1(RUNNER_NAME + jobStartedAt)}`. On a name conflict, retry once with `-<4 hex>` appended.
- Finding thresholds: step duration ≥ 30 s; `mem_full` ≥ 10%; average CPU (usr+sys) ≥ 90%; `io_full` ≥ 20%; average steal ≥ 5%; minimum free space < 1 GiB; swap increased.
- `report.json` `schema_version` is `1` and must validate against `schema/report.schema.json`.
- Dependencies: `@actions/core` `^1.11.1` and `@actions/artifact` `^2.3.2`. Both are CommonJS, and the bundle is CommonJS. Do not upgrade to ESM-only majors.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Rust unit tests must pass on macOS as well as Linux. Anything Linux-only (`posix_fadvise`, `oom_score_adj`) is gated with `#[cfg(target_os = "linux")]`.

## Review Focus

1. **Container jobs (`container:`):** the action runs inside the job container, where `Runner.Worker` isn't visible. Expected behaviour: the watchdog is disabled (`--watch-pid 0`) and the collector runs until `post` stops it. It must *not* watch its short-lived parent and exit at once. Tests are pinned in Task 7 (`findRunnerWorkerPid` returns null), Task 8 (`collectorArgs` emits `0`) and Task 18 (`runMain` passes null through).
2. **The action used twice in one job:** each invocation gets its own data directory and collector, and neither overwrites the other's samples. Pinned in Task 8.
3. **Skipped/pending steps and the in-progress post step:** API steps with `started_at: null` are dropped. The in-progress step with `completed_at: null` takes the trailing samples. Pinned in Task 10 and Task 12.
4. **Truncated or malformed NDJSON:** the collector may be killed mid-write, or a line may be valid JSON with the wrong shape. Such lines are skipped and counted, and aggregation never crashes. Pinned in Task 9.
5. **Collector binary without the executable bit, or failing to spawn:** `main` runs `chmod 0755` before spawning. A spawn `error` event must not crash the `main` process, and a missing PID is reported as a warning. Pinned in Task 8.

---

## File Structure

```
action.yml                         # Marketplace metadata, inputs/outputs, node24 main/post
package.json  package-lock.json  tsconfig.json  vitest.config.ts  .gitignore
LICENSE  README.md
schema/report.schema.json          # JSON Schema for report.json
scripts/verify-e2e.mjs             # e2e assertions over downloaded artifacts
src/
  types.ts                         # NDJSON record types + StepTiming
  inputs.ts                        # readInputs(): validated Inputs
  runner.ts                        # collectorBinaryName(), findRunnerWorkerPid()
  collector-control.ts             # startCollector(), stopCollector()
  samples.ts                       # parseSamples(): ParsedSamples
  steps.ts                         # fetchSteps(), selectCurrentJob(), toStepTimings()
  oom.ts                           # parseDmesg(), readDmesg(), containerOomEvents(), collectorOomEvent()
  format.ts                        # iso(), formatBytes(), formatDuration(), pct(), round1()
  aggregate.ts                     # stepAt(), aggregateSteps(), aggregateContainers(), jobTotals()
  findings.ts                      # THRESHOLDS, computeFindings()
  report.ts                        # Report type, buildReport()
  render/summary.ts                # renderSummary(): Markdown
  render/html.ts                   # renderHtml(): self-contained HTML + SVG
  upload.ts                        # defaultArtifactName(), uploadWithRetry(), artifactUrl()
  main.ts                          # runMain(deps)
  post.ts                          # runPost(deps)
  entry/main.ts  entry/post.ts     # ncc entry points wiring real deps
test/
  fixtures.ts                      # makeSample(), parsed(), makeEnd(), ndjson(), makeReport()
  *.test.ts                        # one per src module
collector/
  Cargo.toml  Cargo.lock
  src/main.rs                      # binary: args, priority, signals → run()
  src/lib.rs                       # module list (+ test_temp helper)
  src/cli.rs                       # Config, parse_args()
  src/record.rs                    # serde record types, now_secs()
  src/writer.rs                    # NDJSON writer, cap levels, page-cache drop
  src/selfstat.rs                  # getrusage → SelfStats
  src/run.rs                       # the tick loop
  src/sources/mod.rs               # Roots, read(), rate(), round1(), clk_tck(), page_size()
  src/sources/{cpu,mem,psi,disk,net,fs,procs,cgroup,docker}.rs
  tests/fixtures/linux/{proc,sys}/…  # procfs/sysfs fixture trees
.github/actions/prepare-e2e/action.yml
.github/workflows/{ci,e2e,release}.yml
```

---

## Part A: Rust collector

### Task 1: Collector crate and CLI parsing

**Files:**
- Create: `collector/Cargo.toml`, `collector/src/lib.rs`, `collector/src/main.rs`, `collector/src/cli.rs`, `.gitignore`

**Interfaces:**
- Produces: `telemetry::cli::Config { out: PathBuf, interval: Duration, proc_interval: Option<Duration>, docker: bool, watch_pid: Option<i32>, max_bytes: u64, max_duration: Duration, workspace: Option<PathBuf> }`, `telemetry::cli::DEFAULT_MAX_BYTES: u64`, `telemetry::cli::parse_args(&[String]) -> Result<Config, String>`

- [ ] **Step 1: Create the crate skeleton**

`collector/Cargo.toml`:
```toml
[package]
name = "ci-telemetry-collector"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
name = "telemetry"
path = "src/lib.rs"

[[bin]]
name = "collector"
path = "src/main.rs"

[dependencies]
libc = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
signal-hook = "0.3"

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

`collector/src/lib.rs`:
```rust
pub mod cli;
```

`collector/src/main.rs` (temporary; replaced in Task 6):
```rust
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = telemetry::cli::parse_args(&args) {
        eprintln!("collector: {e}");
        std::process::exit(2);
    }
}
```

`.gitignore` (repo root):
```
node_modules/
collector/target/
dist/bin/
coverage/
```

- [ ] **Step 2: Write the failing tests**

`collector/src/cli.rs`:
```rust
use std::path::PathBuf;
use std::time::Duration;

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn defaults_apply_when_only_out_given() {
        let c = parse_args(&args("--out /tmp/s.ndjson")).unwrap();
        assert_eq!(c.out, PathBuf::from("/tmp/s.ndjson"));
        assert_eq!(c.interval, Duration::from_secs(1));
        assert_eq!(c.proc_interval, Some(Duration::from_secs(5)));
        assert!(c.docker);
        assert_eq!(c.watch_pid, None);
        assert_eq!(c.max_bytes, 52_428_800);
        assert_eq!(c.max_duration, Duration::from_secs(72 * 3600));
        assert_eq!(c.workspace, None);
    }

    #[test]
    fn all_flags_parse() {
        let c = parse_args(&args(
            "--out o --interval 0.5 --proc-interval 10 --docker false --watch-pid 42 \
             --max-bytes 1000 --max-duration 30m --workspace /w",
        ))
        .unwrap();
        assert_eq!(c.interval, Duration::from_millis(500));
        assert_eq!(c.proc_interval, Some(Duration::from_secs(10)));
        assert!(!c.docker);
        assert_eq!(c.watch_pid, Some(42));
        assert_eq!(c.max_bytes, 1000);
        assert_eq!(c.max_duration, Duration::from_secs(1800));
        assert_eq!(c.workspace, Some(PathBuf::from("/w")));
    }

    #[test]
    fn zero_disables_proc_sampling_and_watchdog() {
        let c = parse_args(&args("--out o --proc-interval 0 --watch-pid 0")).unwrap();
        assert_eq!(c.proc_interval, None);
        assert_eq!(c.watch_pid, None);
    }

    #[test]
    fn out_is_required() {
        assert!(parse_args(&args("--interval 1")).unwrap_err().contains("--out"));
    }

    #[test]
    fn rejects_unknown_flags_and_bad_values() {
        for bad in [
            "--out o --bogus 1",
            "--out o --interval 0",
            "--out o --interval abc",
            "--out o --docker yes",
            "--out o --interval",
            "--out o --max-duration 5x",
            "--out o --watch-pid x",
        ] {
            assert!(parse_args(&args(bad)).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn max_duration_units() {
        let d = |v: &str| parse_args(&args(&format!("--out o --max-duration {v}"))).unwrap().max_duration;
        assert_eq!(d("2h"), Duration::from_secs(7200));
        assert_eq!(d("90s"), Duration::from_secs(90));
        assert_eq!(d("15"), Duration::from_secs(15));
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd collector && cargo test cli::`
Expected: compile error, `cannot find function parse_args`.

- [ ] **Step 4: Implement**

Add above the `#[cfg(test)]` module in `collector/src/cli.rs`:
```rust
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub out: PathBuf,
    pub interval: Duration,
    pub proc_interval: Option<Duration>,
    pub docker: bool,
    pub watch_pid: Option<i32>,
    pub max_bytes: u64,
    pub max_duration: Duration,
    pub workspace: Option<PathBuf>,
}

pub const DEFAULT_MAX_BYTES: u64 = 50 * 1024 * 1024;

pub fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut out = None;
    let mut interval = Duration::from_secs(1);
    let mut proc_interval = Some(Duration::from_secs(5));
    let mut docker = true;
    let mut watch_pid = None;
    let mut max_bytes = DEFAULT_MAX_BYTES;
    let mut max_duration = Duration::from_secs(72 * 3600);
    let mut workspace = None;

    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || it.next().cloned().ok_or_else(|| format!("missing value for {flag}"));
        match flag.as_str() {
            "--out" => out = Some(PathBuf::from(value()?)),
            "--interval" => interval = parse_secs(&value()?, false)?,
            "--proc-interval" => {
                let d = parse_secs(&value()?, true)?;
                proc_interval = if d.is_zero() { None } else { Some(d) };
            }
            "--docker" => docker = parse_bool(&value()?)?,
            "--watch-pid" => {
                let v = value()?;
                let pid: i32 = v.parse().map_err(|_| format!("invalid pid: {v}"))?;
                watch_pid = if pid > 0 { Some(pid) } else { None };
            }
            "--max-bytes" => {
                let v = value()?;
                max_bytes = v.parse().map_err(|_| format!("invalid byte count: {v}"))?;
            }
            "--max-duration" => max_duration = parse_duration(&value()?)?,
            "--workspace" => workspace = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown flag: {other}")),
        }
    }

    Ok(Config {
        out: out.ok_or("--out is required")?,
        interval,
        proc_interval,
        docker,
        watch_pid,
        max_bytes,
        max_duration,
        workspace,
    })
}

fn parse_secs(v: &str, allow_zero: bool) -> Result<Duration, String> {
    let n: f64 = v.parse().map_err(|_| format!("invalid seconds: {v}"))?;
    if !n.is_finite() || n < 0.0 || (!allow_zero && n == 0.0) {
        return Err(format!("invalid seconds: {v}"));
    }
    Ok(Duration::from_secs_f64(n))
}

fn parse_bool(v: &str) -> Result<bool, String> {
    match v {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("invalid boolean: {v}")),
    }
}

fn parse_duration(v: &str) -> Result<Duration, String> {
    let (num, mult) = match v.chars().last() {
        Some('h') => (&v[..v.len() - 1], 3600.0),
        Some('m') => (&v[..v.len() - 1], 60.0),
        Some('s') => (&v[..v.len() - 1], 1.0),
        _ => (v, 1.0),
    };
    let n: f64 = num.parse().map_err(|_| format!("invalid duration: {v}"))?;
    if !n.is_finite() || n <= 0.0 {
        return Err(format!("invalid duration: {v}"));
    }
    Ok(Duration::from_secs_f64(n * mult))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd collector && cargo test cli:: && cargo clippy --all-targets -- -D warnings`
Expected: 6 tests pass; no clippy warnings.

- [ ] **Step 6: Commit** (include `Cargo.lock`)

```bash
git add .gitignore collector/Cargo.toml collector/Cargo.lock collector/src
git commit -m "feat(collector): add crate skeleton and CLI parsing"
```

---

### Task 2: Record types and the CPU, load and memory sources

**Files:**
- Create: `collector/src/record.rs`, `collector/src/sources/mod.rs`, `collector/src/sources/cpu.rs`, `collector/src/sources/mem.rs`
- Create fixtures: `collector/tests/fixtures/linux/proc/{stat,meminfo,loadavg}`
- Modify: `collector/src/lib.rs`

**Interfaces:**
- Produces (`telemetry::record`): `CpuPct{usr,sys,iow,steal: f64}`, `Mem{used,avail,cached,swap: u64}`, `Psi{cpu_some,mem_some,mem_full,io_some,io_full: Option<f64>}`, `Disk{rd,wr: u64}`, `Net{rx,tx: u64}`, `Fs{root_free,ws_free: Option<u64>}`, `ProcEntry{pid: i32, comm: String, cpu: f64, rss: u64}`, `Procs{cpu,rss: Vec<ProcEntry>}`, `Ctr{id: String, cpu: f64, mem: u64, mem_peak: Option<u64>, io_rd: u64, io_wr: u64, oom_kills: u64}`, `Sample{..}`, `Capabilities{psi,docker_cgroups,docker_socket: bool}`, `Meta{..}`, `ContainerInfo{t,id,name,image}`, `Downsample{t,interval}`, `SelfStats{peak_rss: u64, cpu_seconds: f64}`, `End{t, reason: &'static str, self_stats}`, `enum Record{Meta,Sample,Container,Downsample,End}` (tagged `"type"`), `now_secs() -> f64`
- Produces (`telemetry::sources`): `Roots{proc,sys,docker_sock: PathBuf}`, `Roots::real()`, `read(&Path, &str) -> Option<String>`, `rate(u64,u64,f64) -> u64`, `round1(f64) -> f64`, `clk_tck() -> f64`, `page_size() -> u64`, `#[cfg(test)] fixture_roots() -> Roots`
- Produces (`sources::cpu`): `CpuTimes`, `parse_stat(&str) -> Option<CpuTimes>`, `count_cpus(&str) -> u32`, `pct(&CpuTimes,&CpuTimes) -> CpuPct`, `parse_loadavg(&str) -> Option<f64>`
- Produces (`sources::mem`): `MemInfo{total,available,cached,swap_total,swap_free}`, `parse_meminfo(&str) -> Option<MemInfo>`, `MemInfo::to_mem(&self) -> Mem`

- [ ] **Step 1: Create the fixtures**

```bash
F=collector/tests/fixtures/linux/proc && mkdir -p $F
cat > $F/stat <<'EOF'
cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0
cpu0 5066076 145348 1542359 23414241 8341 0 12597 0 0 0
cpu1 5066077 145348 1542360 23414242 8342 0 12598 0 0 0
intr 199292 0 0 0
ctxt 1990473
btime 1759000000
processes 2915
procs_running 1
procs_blocked 0
EOF
cat > $F/meminfo <<'EOF'
MemTotal:        2035000 kB
MemFree:          300000 kB
MemAvailable:    1160000 kB
Buffers:           50000 kB
Cached:           390000 kB
SwapCached:            0 kB
SwapTotal:       1048572 kB
SwapFree:        1048572 kB
EOF
echo "0.92 0.71 0.60 2/345 12345" > $F/loadavg
```

- [ ] **Step 2: Write `record.rs` and `sources/mod.rs`, with tests**

`collector/src/record.rs`:
```rust
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuPct { pub usr: f64, pub sys: f64, pub iow: f64, pub steal: f64 }

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Mem { pub used: u64, pub avail: u64, pub cached: u64, pub swap: u64 }

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Psi {
    pub cpu_some: Option<f64>,
    pub mem_some: Option<f64>,
    pub mem_full: Option<f64>,
    pub io_some: Option<f64>,
    pub io_full: Option<f64>,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Disk { pub rd: u64, pub wr: u64 }

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Net { pub rx: u64, pub tx: u64 }

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Fs { pub root_free: Option<u64>, pub ws_free: Option<u64> }

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ProcEntry { pub pid: i32, pub comm: String, pub cpu: f64, pub rss: u64 }

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Procs { pub cpu: Vec<ProcEntry>, pub rss: Vec<ProcEntry> }

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
pub struct Capabilities { pub psi: bool, pub docker_cgroups: bool, pub docker_socket: bool }

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
pub struct ContainerInfo { pub t: f64, pub id: String, pub name: String, pub image: String }

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Downsample { pub t: f64, pub interval: f64 }

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct SelfStats { pub peak_rss: u64, pub cpu_seconds: f64 }

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
            t: 1.5, cpu: CpuPct::default(), load1: 0.0, mem: Mem::default(), psi: None,
            disk: Disk::default(), net: Net::default(), fs: None, procs: None, ctr: None,
        };
        let v: serde_json::Value = serde_json::to_value(Record::Sample(s)).unwrap();
        assert_eq!(v["type"], "sample");
        assert_eq!(v["t"], 1.5);
        assert!(v.get("psi").is_none());
        assert!(v.get("ctr").is_none());
    }

    #[test]
    fn end_record_uses_self_key() {
        let e = End { t: 2.0, reason: "sigterm", self_stats: SelfStats { peak_rss: 10, cpu_seconds: 0.5 } };
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
```

`collector/src/sources/mod.rs`:
```rust
pub mod cpu;
pub mod mem;

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
    if v > 0 { v as f64 } else { 100.0 }
}

pub fn page_size() -> u64 {
    let v = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if v > 0 { v as u64 } else { 4096 }
}

#[cfg(test)]
pub fn fixture_roots() -> Roots {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/linux");
    Roots { proc: base.join("proc"), sys: base.join("sys"), docker_sock: base.join("no-docker.sock") }
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
```

Update `collector/src/lib.rs`:
```rust
pub mod cli;
pub mod record;
pub mod sources;
```

- [ ] **Step 3: Write the failing CPU and memory tests**

`collector/src/sources/cpu.rs`:
```rust
use crate::record::CpuPct;

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
        let prev = CpuTimes { user: 100, idle: 100, ..Default::default() };
        let cur = CpuTimes { user: 140, nice: 10, system: 20, idle: 110, iowait: 10, steal: 10, ..Default::default() };
        // total delta = 50+20+10+10+10 = 100
        let p = pct(&prev, &cur);
        assert_eq!(p, CpuPct { usr: 50.0, sys: 20.0, iow: 10.0, steal: 10.0 });
    }

    #[test]
    fn pct_is_zero_when_no_time_passed() {
        let t = CpuTimes { user: 5, ..Default::default() };
        assert_eq!(pct(&t, &t), CpuPct::default());
    }

    #[test]
    fn parses_loadavg_and_rejects_garbage() {
        assert_eq!(parse_loadavg("0.92 0.71 0.60 2/345 12345"), Some(0.92));
        assert_eq!(parse_loadavg(""), None);
        assert!(parse_stat("intr 1 2 3").is_none());
    }
}
```

`collector/src/sources/mem.rs`:
```rust
use crate::record::Mem;

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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd collector && cargo test`
Expected: compile errors, `cannot find function parse_stat` / `parse_meminfo`.

- [ ] **Step 5: Implement**

Add at the top of `collector/src/sources/cpu.rs` (after the `use` line):
```rust
use super::round1;

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
        self.user + self.nice + self.system + self.idle + self.iowait + self.irq + self.softirq + self.steal
    }
}

/// Parses the aggregate `cpu ` line of /proc/stat.
pub fn parse_stat(s: &str) -> Option<CpuTimes> {
    let line = s.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line.split_whitespace().skip(1).map(|x| x.parse().unwrap_or(0)).collect();
    if v.len() < 8 {
        return None;
    }
    Some(CpuTimes {
        user: v[0], nice: v[1], system: v[2], idle: v[3],
        iowait: v[4], irq: v[5], softirq: v[6], steal: v[7],
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
        sys: d(prev.system + prev.irq + prev.softirq, cur.system + cur.irq + cur.softirq),
        iow: d(prev.iowait, cur.iowait),
        steal: d(prev.steal, cur.steal),
    }
}

pub fn parse_loadavg(s: &str) -> Option<f64> {
    s.split_whitespace().next()?.parse().ok()
}
```

Add at the top of `collector/src/sources/mem.rs` (after the `use` line):
```rust
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
        let Some(kb) = parts.next().and_then(|v| v.parse::<u64>().ok()) else { continue };
        let bytes = kb * 1024;
        match key {
            "MemTotal:" => { m.total = bytes; seen_total = true; }
            "MemAvailable:" => { m.available = bytes; seen_avail = true; }
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd collector && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all tests pass; no warnings.

- [ ] **Step 7: Commit**

```bash
git add collector
git commit -m "feat(collector): add record types and cpu/load/memory sources"
```

---

### Task 3: PSI, disk, network and filesystem sources

**Files:**
- Create: `collector/src/sources/{psi,disk,net,fs}.rs`
- Create fixtures: `collector/tests/fixtures/linux/proc/pressure/{cpu,memory,io}`, `proc/diskstats`, `proc/net/dev`, `sys/block/{sda,nvme0n1,loop0}/dev`
- Modify: `collector/src/sources/mod.rs` (module list)

**Interfaces:**
- Consumes: `sources::read`, `sources::Roots`, `record::Psi`
- Produces: `psi::parse_pressure(&str) -> (Option<f64>, Option<f64>)`, `psi::read(&Path) -> Option<Psi>`; `disk::parse_diskstats(&str, impl Fn(&str)->bool) -> (u64,u64)` (cumulative bytes), `disk::is_whole_disk(&Path,&str) -> bool`, `disk::read(&Roots) -> Option<(u64,u64)>`; `net::parse_net_dev(&str) -> (u64,u64)` (cumulative bytes); `fs::free_bytes(&Path) -> Option<u64>`

- [ ] **Step 1: Create the fixtures**

```bash
F=collector/tests/fixtures/linux && mkdir -p $F/proc/pressure $F/proc/net $F/sys/block/sda $F/sys/block/nvme0n1 $F/sys/block/loop0
cat > $F/proc/pressure/cpu <<'EOF'
some avg10=3.10 avg60=1.20 avg300=0.50 total=123456
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
EOF
cat > $F/proc/pressure/memory <<'EOF'
some avg10=12.50 avg60=4.00 avg300=1.00 total=5000
full avg10=8.25 avg60=2.00 avg300=0.50 total=2500
EOF
cat > $F/proc/pressure/io <<'EOF'
some avg10=0.40 avg60=0.10 avg300=0.00 total=100
full avg10=0.10 avg60=0.00 avg300=0.00 total=50
EOF
cat > $F/proc/diskstats <<'EOF'
   7       0 loop0 1030 0 2102 150 0 0 0 0 0 204 150 0 0 0 0 0 0
   8       0 sda 51234 1234 4046582 20310 81234 51234 9834124 101234 0 60120 121544 0 0 0 0 1200 800
   8       1 sda1 50000 1234 4000000 20000 81000 51234 9800000 101000 0 60000 121000 0 0 0 0 0 0
 259       0 nvme0n1 100 0 8000 10 200 0 16000 20 0 30 30 0 0 0 0 0 0
 259       1 nvme0n1p1 90 0 7000 10 190 0 15000 20 0 30 30 0 0 0 0 0 0
EOF
cat > $F/proc/net/dev <<'EOF'
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000000 4000 0 0 0 0 0 0 300000 2000 0 0 0 0 0 0
  eth1:123 1 0 0 0 0 0 0 456 2 0 0 0 0 0 0
docker0: 700 7 0 0 0 0 0 0 800 8 0 0 0 0 0 0
vethabc: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0
EOF
for d in sda nvme0n1 loop0; do echo "8:0" > $F/sys/block/$d/dev; done
```

- [ ] **Step 2: Write the failing tests**

`collector/src/sources/psi.rs`:
```rust
use crate::record::Psi;
use std::path::Path;

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
        assert_eq!(p, Psi { cpu_some: Some(3.1), mem_some: Some(12.5), mem_full: Some(8.25), io_some: Some(0.4), io_full: Some(0.1) });
    }

    #[test]
    fn missing_psi_is_none() {
        assert!(read(Path::new("/definitely/not/here")).is_none());
    }
}
```

`collector/src/sources/disk.rs`:
```rust
use super::Roots;
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::fixture_roots;

    #[test]
    fn sums_whole_disks_only() {
        let roots = fixture_roots();
        let (rd, wr) = read(&roots).unwrap();
        assert_eq!(rd, (4046582 + 8000) * 512);
        assert_eq!(wr, (9834124 + 16000) * 512);
    }

    #[test]
    fn skips_virtual_devices_even_if_in_sys_block() {
        let roots = fixture_roots();
        assert!(!is_whole_disk(&roots.sys, "loop0"));
        assert!(is_whole_disk(&roots.sys, "sda"));
        assert!(!is_whole_disk(&roots.sys, "sda1"));
    }

    #[test]
    fn ignores_short_lines() {
        assert_eq!(parse_diskstats("8 0 sda 1 2\n", |_| true), (0, 0));
    }
}
```

`collector/src/sources/net.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    const DEV: &str = include_str!("../../tests/fixtures/linux/proc/net/dev");

    #[test]
    fn sums_non_virtual_interfaces_including_glued_format() {
        // eth0 + eth1 (glued "eth1:123"); lo, docker0, veth* excluded
        assert_eq!(parse_net_dev(DEV), (5_000_123, 300_456));
    }
}
```

`collector/src/sources/fs.rs`:
```rust
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_has_free_space_and_missing_path_is_none() {
        assert!(free_bytes(Path::new("/")).unwrap() > 0);
        assert!(free_bytes(Path::new("/definitely/not/here")).is_none());
    }
}
```

Update the module list in `collector/src/sources/mod.rs`:
```rust
pub mod cpu;
pub mod disk;
pub mod fs;
pub mod mem;
pub mod net;
pub mod psi;
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd collector && cargo test`
Expected: compile errors for the missing `parse_pressure`, `read`, `parse_diskstats`, `parse_net_dev`, `free_bytes`.

- [ ] **Step 4: Implement**

Add to `psi.rs` (above the tests):
```rust
/// Returns (some avg10, full avg10) from a /proc/pressure/* file.
pub fn parse_pressure(s: &str) -> (Option<f64>, Option<f64>) {
    let (mut some, mut full) = (None, None);
    for line in s.lines() {
        let mut parts = line.split_whitespace();
        let kind = parts.next();
        let avg10 = parts.find_map(|p| p.strip_prefix("avg10=")).and_then(|v| v.parse::<f64>().ok());
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
    Some(Psi { cpu_some, mem_some, mem_full, io_some, io_full })
}
```

Add to `disk.rs`:
```rust
const SECTOR: u64 = 512;

/// Cumulative (read bytes, written bytes) across devices accepted by `is_whole_disk`.
pub fn parse_diskstats(s: &str, is_whole_disk: impl Fn(&str) -> bool) -> (u64, u64) {
    let (mut rd, mut wr) = (0, 0);
    for line in s.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 || !is_whole_disk(f[2]) {
            continue;
        }
        rd += f[5].parse::<u64>().unwrap_or(0) * SECTOR;
        wr += f[9].parse::<u64>().unwrap_or(0) * SECTOR;
    }
    (rd, wr)
}

/// Whole disks appear in /sys/block; partitions don't. Virtual/stacked devices are skipped
/// so LVM, RAID and loop traffic isn't double counted.
pub fn is_whole_disk(sys_root: &Path, name: &str) -> bool {
    const SKIP: [&str; 6] = ["loop", "ram", "zram", "dm-", "md", "sr"];
    !SKIP.iter().any(|p| name.starts_with(p)) && sys_root.join("block").join(name).exists()
}

pub fn read(roots: &Roots) -> Option<(u64, u64)> {
    let s = super::read(&roots.proc, "diskstats")?;
    Some(parse_diskstats(&s, |n| is_whole_disk(&roots.sys, n)))
}
```

Add to `net.rs` (at the top):
```rust
/// Cumulative (rx bytes, tx bytes) across physical-ish interfaces. Bridge/veth interfaces are
/// excluded because container traffic also crosses the host NIC.
pub fn parse_net_dev(s: &str) -> (u64, u64) {
    let (mut rx, mut tx) = (0, 0);
    for line in s.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else { continue };
        if is_virtual(name.trim()) {
            continue;
        }
        let f: Vec<u64> = rest.split_whitespace().map(|x| x.parse().unwrap_or(0)).collect();
        if f.len() < 9 {
            continue;
        }
        rx += f[0];
        tx += f[8];
    }
    (rx, tx)
}

fn is_virtual(name: &str) -> bool {
    name == "lo" || ["docker", "veth", "br-", "cni", "flannel", "virbr"].iter().any(|p| name.starts_with(p))
}
```

Add to `fs.rs`:
```rust
/// Bytes available to unprivileged users on the filesystem holding `path`.
#[allow(clippy::unnecessary_cast)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd collector && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add collector
git commit -m "feat(collector): add psi, disk, network and filesystem sources"
```

---

### Task 4: Top-process sampler

**Files:**
- Create: `collector/src/sources/procs.rs`, fixture `collector/tests/fixtures/linux/proc/4242/stat`
- Modify: `collector/src/sources/mod.rs` (add `pub mod procs;`)

**Interfaces:**
- Consumes: `record::{ProcEntry, Procs}`, `sources::round1`
- Produces: `procs::PidStat{pid: i32, comm: String, ticks: u64, rss_pages: u64}`, `procs::parse_pid_stat(&str) -> Option<PidStat>`, `procs::top_n(Vec<ProcEntry>, usize) -> Procs`, `procs::ProcSampler::new(clk_tck: f64, page_size: u64)`, `ProcSampler::sample(&mut self, proc_root: &Path, elapsed_secs: f64) -> Procs` (CPU is % of one core; 0 for a PID seen for the first time)

- [ ] **Step 1: Create the fixture**

```bash
mkdir -p collector/tests/fixtures/linux/proc/4242
echo "4242 (node server) S 1 4242 4242 0 -1 4194304 1000 0 0 0 1500 300 0 0 20 0 11 0 5000 1000000000 51200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0" \
  > collector/tests/fixtures/linux/proc/4242/stat
```

- [ ] **Step 2: Write the failing tests**

`collector/src/sources/procs.rs`:
```rust
use super::round1;
use crate::record::{ProcEntry, Procs};
use std::collections::HashMap;
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::fixture_roots;

    fn e(pid: i32, cpu: f64, rss: u64) -> ProcEntry {
        ProcEntry { pid, comm: format!("p{pid}"), cpu, rss }
    }

    #[test]
    fn parses_stat_with_spaces_in_comm() {
        let s = std::fs::read_to_string(fixture_roots().proc.join("4242/stat")).unwrap();
        let p = parse_pid_stat(&s).unwrap();
        assert_eq!(p, PidStat { pid: 4242, comm: "node server".into(), ticks: 1800, rss_pages: 51200 });
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
```

Add `pub mod procs;` to the module list in `sources/mod.rs`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd collector && cargo test procs::`
Expected: compile errors for the missing `parse_pid_stat`, `PidStat`, `top_n`, `ProcSampler`.

- [ ] **Step 4: Implement** (above the tests in `procs.rs`)

```rust
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
    Some(PidStat { pid, comm, ticks: num(11)? + num(12)?, rss_pages: num(21)? })
}

pub fn top_n(mut entries: Vec<ProcEntry>, n: usize) -> Procs {
    entries.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(a.pid.cmp(&b.pid)));
    let cpu = entries.iter().filter(|e| e.cpu > 0.0).take(n).cloned().collect();
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
        ProcSampler { prev: HashMap::new(), clk_tck, page_size }
    }

    /// Top 5 by CPU (% of one core since the previous call) and by RSS.
    pub fn sample(&mut self, proc_root: &Path, elapsed_secs: f64) -> Procs {
        let mut entries = Vec::new();
        let mut next = HashMap::new();
        if let Ok(dir) = std::fs::read_dir(proc_root) {
            for ent in dir.flatten() {
                let Some(pid) = ent.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
                let Ok(s) = std::fs::read_to_string(ent.path().join("stat")) else { continue };
                let Some(st) = parse_pid_stat(&s) else { continue };
                let cpu = match self.prev.get(&pid) {
                    Some(&p) if elapsed_secs > 0.0 => {
                        round1(st.ticks.saturating_sub(p) as f64 / self.clk_tck / elapsed_secs * 100.0)
                    }
                    _ => 0.0,
                };
                next.insert(pid, st.ticks);
                entries.push(ProcEntry { pid, comm: st.comm, cpu, rss: st.rss_pages * self.page_size });
            }
        }
        self.prev = next;
        top_n(entries, 5)
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd collector && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add collector
git commit -m "feat(collector): add top-process sampler"
```

---

### Task 5: Container cgroup sampler and Docker name lookup

**Files:**
- Create: `collector/src/sources/cgroup.rs`, `collector/src/sources/docker.rs`
- Create fixtures: `collector/tests/fixtures/linux/sys/fs/cgroup/…`
- Modify: `collector/src/sources/mod.rs` (add `pub mod cgroup; pub mod docker;`), `collector/src/lib.rs` (add the `test_temp` helper)

**Interfaces:**
- Consumes: `record::Ctr`, `sources::{rate, round1}`
- Produces: `cgroup::detect_version(&Path) -> &'static str` (`"v2"|"v1"|"none"`), `cgroup::list_docker_cgroups(&Path) -> Vec<(String, PathBuf)>`, `cgroup::CgroupCounters`, `cgroup::read_counters(&Path) -> Option<CgroupCounters>`, `cgroup::parse_kv(&str,&str) -> Option<u64>`, `cgroup::parse_io_stat(&str) -> (u64,u64)`, `cgroup::CtrSampler` (`Default`), `CtrSampler::sample(&mut self, sys_root: &Path, elapsed_secs: f64) -> (Vec<Ctr>, Vec<String> /* new ids */)`; `docker::parse_inspect_response(&[u8]) -> Option<(String,String)>`, `docker::inspect(&Path, &str, Duration) -> Option<(String,String)>`, `docker::socket_available(&Path) -> bool`; `#[cfg(test)] crate::test_temp(&str) -> PathBuf`

- [ ] **Step 1: Create the fixtures**

```bash
ID=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
C=collector/tests/fixtures/linux/sys/fs/cgroup
mkdir -p "$C/system.slice/docker-$ID.scope" "$C/system.slice/ssh.service" "$C/system.slice/docker-short.scope"
echo "cpuset cpu io memory pids" > $C/cgroup.controllers
echo "usage_usec 1" > $C/system.slice/ssh.service/cpu.stat
echo "usage_usec 1" > $C/system.slice/docker-short.scope/cpu.stat
S="$C/system.slice/docker-$ID.scope"
printf 'usage_usec 2000000\nuser_usec 1500000\nsystem_usec 500000\n' > $S/cpu.stat
echo 90000000 > $S/memory.current
echo 95000000 > $S/memory.peak
printf 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n' > $S/memory.events
printf '8:0 rbytes=4096 wbytes=8192 rios=1 wios=2 dbytes=0 dios=0\n259:0 rbytes=0 wbytes=4096 rios=0 wios=1 dbytes=0 dios=0\n' > $S/io.stat
```

- [ ] **Step 2: Add the test temp-dir helper**

Append to `collector/src/lib.rs`:
```rust
#[cfg(test)]
pub(crate) fn test_temp(name: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ct-{}-{}-{}",
        name,
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
```

- [ ] **Step 3: Write the failing tests**

`collector/src/sources/cgroup.rs`:
```rust
use super::{rate, round1};
use crate::record::Ctr;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
        let ids: Vec<String> = list_docker_cgroups(&fixture_roots().sys).into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec![ID.to_string()]);
    }

    #[test]
    fn reads_counters() {
        let (_, dir) = list_docker_cgroups(&fixture_roots().sys).remove(0);
        let c = read_counters(&dir).unwrap();
        assert_eq!(c, CgroupCounters { usage_usec: 2_000_000, mem: 90_000_000, mem_peak: Some(95_000_000), rbytes: 4096, wbytes: 12288, oom_kills: 1 });
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
```

`collector/src/sources/docker.rs`:
```rust
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    const OK: &[u8] = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"Name\":\"/db\",\"Config\":{\"Image\":\"postgres:16\"}}";

    #[test]
    fn parses_ok_response() {
        assert_eq!(parse_inspect_response(OK), Some(("db".into(), "postgres:16".into())));
    }

    #[test]
    fn rejects_non_200_and_garbage() {
        assert_eq!(parse_inspect_response(b"HTTP/1.0 404 Not Found\r\n\r\n{\"message\":\"x\"}"), None);
        assert_eq!(parse_inspect_response(b"garbage"), None);
    }

    #[test]
    fn inspect_talks_http_over_unix_socket() {
        let sock = crate::test_temp("docker").join("d.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = conn.read(&mut buf).unwrap();
            conn.write_all(OK).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        let got = inspect(&sock, "abc", Duration::from_millis(500));
        let req = server.join().unwrap();
        assert!(req.starts_with("GET /containers/abc/json HTTP/1.0\r\n"), "{req}");
        assert_eq!(got, Some(("db".into(), "postgres:16".into())));
    }

    #[test]
    fn missing_socket_is_none() {
        let p = Path::new("/definitely/not/here.sock");
        assert_eq!(inspect(p, "abc", Duration::from_millis(100)), None);
        assert!(!socket_available(p));
    }
}
```

Update the module list in `sources/mod.rs` so that it reads, in full:
```rust
pub mod cgroup;
pub mod cpu;
pub mod disk;
pub mod docker;
pub mod fs;
pub mod mem;
pub mod net;
pub mod procs;
pub mod psi;
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd collector && cargo test cgroup:: docker::`
Expected: compile errors for the missing functions and types.

- [ ] **Step 5: Implement**

Add to `cgroup.rs` above the tests:
```rust
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
            let id = name.to_str().and_then(|n| n.strip_prefix("docker-")).and_then(|n| n.strip_suffix(".scope"));
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
        if p.next()? == key { p.next()?.parse().ok() } else { None }
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
        mem: rd("memory.current").and_then(|s| s.trim().parse().ok()).unwrap_or(0),
        mem_peak: rd("memory.peak").and_then(|s| s.trim().parse().ok()),
        rbytes,
        wbytes,
        oom_kills: rd("memory.events").and_then(|s| parse_kv(&s, "oom_kill")).unwrap_or(0),
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
            let Some(c) = read_counters(&dir) else { continue };
            let (cpu, io_rd, io_wr) = match self.prev.get(&id) {
                Some(p) if elapsed_secs > 0.0 => (
                    round1(c.usage_usec.saturating_sub(p.usage_usec) as f64 / 1e6 / elapsed_secs * 100.0),
                    rate(p.rbytes, c.rbytes, elapsed_secs),
                    rate(p.wbytes, c.wbytes, elapsed_secs),
                ),
                Some(_) => (0.0, 0, 0),
                None => {
                    new_ids.push(id.clone());
                    (0.0, 0, 0)
                }
            };
            out.push(Ctr { id: id.clone(), cpu, mem: c.mem, mem_peak: c.mem_peak, io_rd, io_wr, oom_kills: c.oom_kills });
            next.insert(id, c);
        }
        self.prev = next;
        (out, new_ids)
    }
}
```

Add to `docker.rs` above the tests:
```rust
/// Extracts (name, image) from a raw HTTP/1.0 response to GET /containers/{id}/json.
pub fn parse_inspect_response(raw: &[u8]) -> Option<(String, String)> {
    let text = std::str::from_utf8(raw).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    if head.lines().next()?.split_whitespace().nth(1)? != "200" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let name = v.get("Name")?.as_str()?.trim_start_matches('/').to_string();
    let image = v.get("Config")?.get("Image")?.as_str()?.to_string();
    Some((name, image))
}

/// One short request per newly seen container; HTTP/1.0 so the daemon closes the connection.
pub fn inspect(sock: &Path, id: &str, timeout: Duration) -> Option<(String, String)> {
    let mut s = UnixStream::connect(sock).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(s, "GET /containers/{id}/json HTTP/1.0\r\nHost: docker\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    s.take(4 * 1024 * 1024).read_to_end(&mut buf).ok()?;
    parse_inspect_response(&buf)
}

pub fn socket_available(sock: &Path) -> bool {
    UnixStream::connect(sock).is_ok()
}
```


- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd collector && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add collector
git commit -m "feat(collector): add docker cgroup sampler and container name lookup"
```

---

### Task 6: Writer, self-stats, the tick loop and the binary

**Files:**
- Create: `collector/src/writer.rs`, `collector/src/selfstat.rs`, `collector/src/run.rs`
- Modify: `collector/src/lib.rs`, `collector/src/main.rs`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: `writer::Writer::create(&Path, max_bytes: u64) -> io::Result<Writer>`, `Writer::write(&mut self, &Record) -> io::Result<()>`, `Writer::cap_level(&self) -> u32`; `selfstat::read() -> SelfStats`; `run::EndReason{Sigterm,WatchPidGone,MaxDuration}` with `as_str()` returning `"sigterm"|"watch-pid-gone"|"max-duration"`; `run::run(&Config, &Roots, &AtomicBool) -> io::Result<EndReason>`. Binary contract: `collector --out … [flags]`; exits 0 on SIGTERM/SIGINT after writing an `end` record, and 2 on bad args.

- [ ] **Step 1: Write the failing tests**

`collector/src/writer.rs`:
```rust
use crate::record::Record;
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::Downsample;

    #[test]
    fn writes_one_json_line_per_record_and_tracks_cap_level() {
        let path = crate::test_temp("writer").join("nested/s.ndjson");
        let mut w = Writer::create(&path, 40).unwrap();
        assert_eq!(w.cap_level(), 0);
        for i in 0..2 {
            w.write(&Record::Downsample(Downsample { t: i as f64, interval: 2.0 })).unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let v: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(v["type"], "downsample");
        assert!(w.cap_level() >= 1, "{} bytes over a 40-byte cap", text.len());
    }
}
```

`collector/src/selfstat.rs`:
```rust
use crate::record::SelfStats;

#[cfg(test)]
mod tests {
    #[test]
    fn reports_nonzero_peak_rss() {
        let s = super::read();
        assert!(s.peak_rss > 0);
        assert!(s.cpu_seconds >= 0.0);
    }
}
```

`collector/src/run.rs`:
```rust
use crate::cli::Config;
use crate::record::*;
use crate::sources::{self, cgroup, cpu, disk, docker, fs, mem, net, procs, psi, Roots};
use crate::writer::Writer;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

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
        std::fs::read_to_string(p).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
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
        let c = Config { watch_pid: Some(999_999), ..cfg(out.clone()) };
        assert_eq!(run_for(&c, 5_000), EndReason::WatchPidGone);
        assert_eq!(lines(&out).last().unwrap()["reason"], "watch-pid-gone");
    }

    #[test]
    fn exits_at_max_duration_while_watched_pid_lives() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config { watch_pid: Some(4242), max_duration: Duration::from_millis(200), ..cfg(out) };
        assert_eq!(run_for(&c, 5_000), EndReason::MaxDuration);
    }

    #[test]
    fn downsamples_after_cap() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config { max_bytes: 200, ..cfg(out.clone()) };
        run_for(&c, 300);
        let ds: Vec<_> = lines(&out).into_iter().filter(|r| r["type"] == "downsample").collect();
        assert!(!ds.is_empty());
        assert!(ds[0]["interval"].as_f64().unwrap() > 0.05);
    }

    #[test]
    fn docker_disabled_omits_container_sampling() {
        let out = crate::test_temp("run").join("s.ndjson");
        let c = Config { docker: false, ..cfg(out.clone()) };
        run_for(&c, 200);
        let recs = lines(&out);
        assert_eq!(recs[0]["capabilities"]["docker_cgroups"], false);
        assert!(recs.iter().filter(|r| r["type"] == "sample").all(|r| r.get("ctr").is_none()));
    }
}
```

Update `collector/src/lib.rs` so its module list is:
```rust
pub mod cli;
pub mod record;
pub mod run;
pub mod selfstat;
pub mod sources;
pub mod writer;
```
(keep the `test_temp` helper below it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd collector && cargo test`
Expected: compile errors for the missing `Writer`, `read`, `run`, `EndReason`.

- [ ] **Step 3: Implement the writer and self-stats**

Add to `writer.rs` above the tests:
```rust
pub struct Writer {
    file: File,
    written: u64,
    lines: u64,
    max_bytes: u64,
}

impl Writer {
    pub fn create(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Writer { file: File::create(path)?, written: 0, lines: 0, max_bytes })
    }

    /// One unbuffered write per line, so a crash can only truncate the last line.
    pub fn write(&mut self, rec: &Record) -> io::Result<()> {
        let mut line = serde_json::to_vec(rec).map_err(io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.written += line.len() as u64;
        self.lines += 1;
        if self.lines % 64 == 0 {
            self.drop_cache();
        }
        Ok(())
    }

    /// 0 while under the cap, 1 once past it, 2 at twice the cap, and so on.
    pub fn cap_level(&self) -> u32 {
        if self.max_bytes == 0 { 0 } else { (self.written / self.max_bytes) as u32 }
    }

    /// Best effort: ask the kernel to drop our already-written pages from the page cache.
    #[cfg(target_os = "linux")]
    fn drop_cache(&self) {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::posix_fadvise(self.file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn drop_cache(&self) {}
}
```

Add to `selfstat.rs` above the tests:
```rust
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
```

- [ ] **Step 4: Implement the loop**

Add to `run.rs` above the tests:
```rust
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
            Some(prev.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0))
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
    let s = |f: &[libc::c_char]| unsafe { std::ffi::CStr::from_ptr(f.as_ptr()) }.to_string_lossy().into_owned();
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
            (Some(a), Some(b)) => Disk { rd: sources::rate(a.0, b.0, secs), wr: sources::rate(a.1, b.1, secs) },
            _ => Disk::default(),
        };
        let net_rate = match (prev.net, cur.net) {
            (Some(a), Some(b)) => Net { rx: sources::rate(a.0, b.0, secs), tx: sources::rate(a.1, b.1, secs) },
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
            load1: sources::read(&roots.proc, "loadavg").and_then(|s| cpu::parse_loadavg(&s)).unwrap_or(0.0),
            mem: meminfo_now(roots),
            psi: if caps.psi { psi::read(&roots.proc) } else { None },
            disk: disk_rate,
            net: net_rate,
            fs: fs_rec,
            procs: procs_rec,
            ctr: ctr_rec,
        }))?;

        if caps.docker_socket {
            for id in new_ids {
                if let Some((name, image)) = docker::inspect(&roots.docker_sock, &id, INSPECT_TIMEOUT) {
                    w.write(&Record::Container(ContainerInfo { t: now_secs(), id, name, image }))?;
                }
            }
        }

        prev = cur;
        prev_at = now;
        let new_level = w.cap_level();
        if new_level > level {
            level = new_level;
            interval = cfg.interval * 2u32.pow(level.min(10));
            w.write(&Record::Downsample(Downsample { t: now_secs(), interval: interval.as_secs_f64() }))?;
        }
    };

    w.write(&Record::End(End { t: now_secs(), reason: reason.as_str(), self_stats: crate::selfstat::read() }))?;
    Ok(reason)
}

fn meminfo_now(roots: &Roots) -> Mem {
    sources::read(&roots.proc, "meminfo")
        .and_then(|s| mem::parse_meminfo(&s))
        .map(|m| m.to_mem())
        .unwrap_or_default()
}
```

- [ ] **Step 5: Replace `main.rs`**

```rust
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cfg = match telemetry::cli::parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("collector: {e}");
            std::process::exit(2);
        }
    };
    lower_priority();
    let stop = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        let _ = signal_hook::flag::register(sig, Arc::clone(&stop));
    }
    if let Err(e) = telemetry::run::run(&cfg, &telemetry::sources::Roots::real(), &stop) {
        eprintln!("collector: {e}");
        std::process::exit(1);
    }
}

/// Lowest CPU priority, and first in line for the OOM killer so the user's build survives.
fn lower_priority() {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 19);
    }
    #[cfg(target_os = "linux")]
    let _ = std::fs::write("/proc/self/oom_score_adj", "1000");
}
```

- [ ] **Step 6: Run the tests and lints**

Run: `cd collector && cargo fmt && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all tests pass (the Task 6 tests take about 1 s); no warnings.

- [ ] **Step 7: Linux smoke test** (required, because macOS has no `/proc`)

Run:
```bash
docker run --rm -v "$PWD/collector":/w -w /w rust:1 bash -c '
  cargo test --quiet &&
  cargo build --release --quiet &&
  (./target/release/collector --out /tmp/s.ndjson --interval 1 --watch-pid $$ & P=$!; sleep 4; kill -TERM $P; wait $P; echo "exit=$?") &&
  head -c 600 /tmp/s.ndjson && echo && tail -n1 /tmp/s.ndjson &&
  grep VmHWM /proc/self/status >/dev/null'
```
Expected: `exit=0`. The first line is a `meta` record with `"cgroup"` present. There are 3 or 4 `sample` lines with non-zero `mem.used`, and the last line is `{"type":"end",…"reason":"sigterm",…}` with `peak_rss` under 5,000,000.

- [ ] **Step 8: Commit**

```bash
git add collector
git commit -m "feat(collector): add writer, self-stats and sampling loop"
```

---

## Part B: TypeScript action

### Task 7: TypeScript scaffold, record types, inputs and runner detection

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `src/inputs.ts`, `src/runner.ts`
- Test: `test/inputs.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Produces (`src/types.ts`): `CpuPct`, `Mem`, `Psi`, `ProcEntry`, `Ctr`, `Sample`, `Meta`, `ContainerRecord`, `Downsample`, `End`, `ParsedSamples { meta: Meta|null; samples: Sample[]; containers: Map<string,{name:string;image:string}>; downsamples: Downsample[]; end: End|null; invalidLines: number }`, `StepTiming { name: string; number: number; conclusion: string|null; started_at: number; completed_at: number|null }` (epoch seconds)
- Produces (`src/inputs.ts`): `Inputs { interval; processInterval; docker; githubToken; artifactName; retentionDays; jobSummary; htmlReport }`, `readInputs(get?: (name)=>string, warn?: (msg)=>void): Inputs`
- Produces (`src/runner.ts`): `collectorBinaryName(platform?, arch?): string|null`, `ProcReader { comm(pid): string|null; ppid(pid): number|null }`, `procfsReader`, `findRunnerWorkerPid(startPid, reader?, maxDepth?): number|null`

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "ci-telemetry",
  "version": "0.1.0",
  "private": true,
  "description": "Lightweight per-step CI job telemetry, uploaded as an artifact",
  "license": "MIT",
  "scripts": {
    "build": "ncc build src/entry/main.ts -o dist/main --license licenses.txt && ncc build src/entry/post.ts -o dist/post --license licenses.txt",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@actions/artifact": "^2.3.2",
    "@actions/core": "^1.11.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@vercel/ncc": "^0.38.3",
    "ajv": "^8.17.1",
    "typescript": "^5.6.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```
(`DOM` is in `lib` only for the global `fetch`, `Response` and `AbortSignal` types.)

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

Run: `npm install` and confirm `package-lock.json` is created.

`src/types.ts`:
```ts
export interface CpuPct { usr: number; sys: number; iow: number; steal: number }
export interface Mem { used: number; avail: number; cached: number; swap: number }
export interface Psi {
  cpu_some: number | null;
  mem_some: number | null;
  mem_full: number | null;
  io_some: number | null;
  io_full: number | null;
}
export interface ProcEntry { pid: number; comm: string; cpu: number; rss: number }
export interface Ctr {
  id: string;
  cpu: number;
  mem: number;
  mem_peak: number | null;
  io_rd: number;
  io_wr: number;
  oom_kills: number;
}

export interface Sample {
  type: 'sample';
  t: number;
  cpu: CpuPct;
  load1: number;
  mem: Mem;
  psi?: Psi;
  disk: { rd: number; wr: number };
  net: { rx: number; tx: number };
  fs?: { root_free: number | null; ws_free: number | null };
  procs?: { cpu: ProcEntry[]; rss: ProcEntry[] };
  ctr?: Ctr[];
}

export interface Meta {
  type: 'meta';
  v: number;
  t: number;
  interval: number;
  cpus: number;
  mem_total: number;
  kernel: string;
  arch: string;
  cgroup: string;
  capabilities: { psi: boolean; docker_cgroups: boolean; docker_socket: boolean };
}

export interface ContainerRecord { type: 'container'; t: number; id: string; name: string; image: string }
export interface Downsample { type: 'downsample'; t: number; interval: number }
export interface End {
  type: 'end';
  t: number;
  reason: string;
  self: { peak_rss: number; cpu_seconds: number };
}

export interface ParsedSamples {
  meta: Meta | null;
  samples: Sample[];
  containers: Map<string, { name: string; image: string }>;
  downsamples: Downsample[];
  end: End | null;
  invalidLines: number;
}

/** A job step with epoch-second timestamps. completed_at is null while in progress. */
export interface StepTiming {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: number;
  completed_at: number | null;
}
```

- [ ] **Step 2: Write the failing tests**

`test/inputs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readInputs } from '../src/inputs';

const getter = (values: Record<string, string>) => (name: string) => values[name] ?? '';

describe('readInputs', () => {
  it('returns defaults for empty inputs', () => {
    const warnings: string[] = [];
    expect(readInputs(getter({}), (m) => warnings.push(m))).toEqual({
      interval: 1, processInterval: 5, docker: true, githubToken: '', artifactName: '',
      retentionDays: 7, jobSummary: true, htmlReport: true,
    });
    expect(warnings).toEqual([]);
  });

  it('parses valid values', () => {
    const i = readInputs(getter({
      interval: '2', 'process-interval': '0', docker: 'FALSE', 'github-token': ' tok ',
      'artifact-name': 'my-telemetry', 'retention-days': '30', 'job-summary': 'false', 'html-report': 'true',
    }), () => {});
    expect(i).toEqual({
      interval: 2, processInterval: 0, docker: false, githubToken: 'tok', artifactName: 'my-telemetry',
      retentionDays: 30, jobSummary: false, htmlReport: true,
    });
  });

  it('falls back to defaults with a warning for invalid values', () => {
    const warnings: string[] = [];
    const i = readInputs(getter({ interval: '0', 'process-interval': 'abc', docker: 'yes', 'retention-days': '400' }), (m) => warnings.push(m));
    expect(i.interval).toBe(1);
    expect(i.processInterval).toBe(5);
    expect(i.docker).toBe(true);
    expect(i.retentionDays).toBe(7);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("'interval'");
  });
});
```

`test/runner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectorBinaryName, findRunnerWorkerPid, ProcReader } from '../src/runner';

function tree(nodes: Record<number, { comm: string; ppid: number }>): ProcReader {
  return { comm: (p) => nodes[p]?.comm ?? null, ppid: (p) => nodes[p]?.ppid ?? null };
}

describe('collectorBinaryName', () => {
  it('maps supported linux architectures', () => {
    expect(collectorBinaryName('linux', 'x64')).toBe('collector-linux-x64');
    expect(collectorBinaryName('linux', 'arm64')).toBe('collector-linux-arm64');
  });
  it('returns null for unsupported platforms', () => {
    expect(collectorBinaryName('darwin', 'arm64')).toBeNull();
    expect(collectorBinaryName('win32', 'x64')).toBeNull();
    expect(collectorBinaryName('linux', 'ia32')).toBeNull();
  });
});

describe('findRunnerWorkerPid', () => {
  it('walks up to Runner.Worker', () => {
    const r = tree({ 100: { comm: 'node', ppid: 90 }, 90: { comm: 'bash', ppid: 80 }, 80: { comm: 'Runner.Worker', ppid: 70 } });
    expect(findRunnerWorkerPid(100, r)).toBe(80);
  });
  it('returns null inside a container job where the worker is not visible', () => {
    const r = tree({ 12: { comm: 'node', ppid: 1 }, 1: { comm: 'tail', ppid: 0 } });
    expect(findRunnerWorkerPid(12, r)).toBeNull();
  });
  it('stops at maxDepth on a cycle', () => {
    const r = tree({ 5: { comm: 'a', ppid: 6 }, 6: { comm: 'b', ppid: 5 } });
    expect(findRunnerWorkerPid(5, r, 10)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/inputs.test.ts test/runner.test.ts`
Expected: FAIL, `Failed to resolve import "../src/inputs"`.

- [ ] **Step 4: Implement**

`src/inputs.ts`:
```ts
import * as core from '@actions/core';

export interface Inputs {
  interval: number;
  processInterval: number;
  docker: boolean;
  githubToken: string;
  artifactName: string;
  retentionDays: number;
  jobSummary: boolean;
  htmlReport: boolean;
}

type Getter = (name: string) => string;
type Warn = (msg: string) => void;

function num(get: Getter, warn: Warn, name: string, def: number, min: number, max: number): number {
  const raw = get(name).trim();
  if (raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    warn(`ci-telemetry: input '${name}' must be a number between ${min} and ${max}; got '${raw}', using ${def}`);
    return def;
  }
  return v;
}

function bool(get: Getter, warn: Warn, name: string, def: boolean): boolean {
  const raw = get(name).trim().toLowerCase();
  if (raw === '') return def;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  warn(`ci-telemetry: input '${name}' must be true or false; got '${raw}', using ${def}`);
  return def;
}

/** Never throws: invalid values fall back to their defaults with a warning. */
export function readInputs(get: Getter = (n) => core.getInput(n), warn: Warn = core.warning): Inputs {
  return {
    interval: num(get, warn, 'interval', 1, 1, 60),
    processInterval: num(get, warn, 'process-interval', 5, 0, 300),
    docker: bool(get, warn, 'docker', true),
    githubToken: get('github-token').trim(),
    artifactName: get('artifact-name').trim(),
    retentionDays: Math.round(num(get, warn, 'retention-days', 7, 1, 90)),
    jobSummary: bool(get, warn, 'job-summary', true),
    htmlReport: bool(get, warn, 'html-report', true),
  };
}
```

`src/runner.ts`:
```ts
import * as fs from 'node:fs';

export function collectorBinaryName(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform !== 'linux') return null;
  if (arch === 'x64') return 'collector-linux-x64';
  if (arch === 'arm64') return 'collector-linux-arm64';
  return null;
}

export interface ProcReader {
  comm(pid: number): string | null;
  ppid(pid: number): number | null;
}

export const procfsReader: ProcReader = {
  comm: (pid) => {
    try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
  },
  ppid: (pid) => {
    try {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const v = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
      return Number.isInteger(v) ? v : null;
    } catch {
      return null;
    }
  },
};

/**
 * The runner's per-job worker process. The collector exits when it disappears, so an
 * orphaned collector can't outlive its job on a persistent self-hosted runner.
 * Returns null when not visible (e.g. inside a `container:` job): the watchdog is then disabled.
 */
export function findRunnerWorkerPid(startPid: number, reader: ProcReader = procfsReader, maxDepth = 10): number | null {
  let pid: number | null = startPid;
  for (let i = 0; i < maxDepth && pid !== null && pid > 1; i++) {
    if (reader.comm(pid) === 'Runner.Worker') return pid;
    pid = reader.ppid(pid);
  }
  return null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src test
git commit -m "feat(action): scaffold TypeScript action with inputs and runner detection"
```

---

### Task 8: Collector start and stop

**Files:**
- Create: `src/collector-control.ts`
- Test: `test/collector-control.test.ts`

**Interfaces:**
- Produces: `StartOptions { binPath; runnerTemp; interval; processInterval; docker; watchPid: number|null; workspace?: string }`, `StartResult { pid; dataDir; dataFile }`, `SpawnFn`, `collectorArgs(o, dataFile): string[]`, `startCollector(o, spawnFn?): StartResult` (throws when no PID), `StopResult = 'stopped'|'killed'|'not-running'`, `ProcessOps { kill; isAlive; sleep }`, `realProcessOps`, `stopCollector(pid, ops?, timeoutMs?): Promise<StopResult>`

- [ ] **Step 1: Write the failing tests**

`test/collector-control.test.ts`:
```ts
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectorArgs, ProcessOps, startCollector, StartOptions, stopCollector } from '../src/collector-control';

function fakeSpawn(pid: number | undefined) {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const fn: any = (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const child: any = new EventEmitter();
    child.pid = pid;
    child.unref = () => { child.unrefed = true; };
    setImmediate(() => { if (pid === undefined) child.emit('error', new Error('spawn ENOENT')); });
    return child;
  };
  return { fn, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
const opts = (runnerTemp: string, o: Partial<StartOptions> = {}): StartOptions => ({
  binPath: path.join(runnerTemp, 'no-such-collector'), runnerTemp, interval: 1, processInterval: 5,
  docker: true, watchPid: 77, workspace: '/ws', ...o,
});

describe('collectorArgs', () => {
  it('passes 0 when the worker pid is unknown (container jobs)', () => {
    const a = collectorArgs(opts('/t', { watchPid: null, workspace: undefined }), '/t/s.ndjson');
    expect(a).toEqual(['--out', '/t/s.ndjson', '--interval', '1', '--proc-interval', '5', '--docker', 'true', '--watch-pid', '0']);
  });
});

describe('startCollector', () => {
  it('spawns detached with ignored stdio and returns paths', () => {
    const rt = tmp();
    const { fn, calls } = fakeSpawn(4321);
    const r = startCollector(opts(rt), fn);
    expect(r.pid).toBe(4321);
    expect(r.dataDir).toMatch(new RegExp(`^${rt}/ci-telemetry/[0-9a-f]{8}$`));
    expect(fs.existsSync(r.dataDir)).toBe(true);
    expect(r.dataFile).toBe(path.join(r.dataDir, 'samples.ndjson'));
    expect(calls[0].opts).toEqual({ detached: true, stdio: 'ignore' });
    expect(calls[0].args).toContain('--workspace');
  });

  it('gives each invocation in the same job its own data dir', () => {
    const rt = tmp();
    const a = startCollector(opts(rt), fakeSpawn(1).fn);
    const b = startCollector(opts(rt), fakeSpawn(2).fn);
    expect(a.dataDir).not.toBe(b.dataDir);
  });

  it('makes the binary executable before spawning', () => {
    const rt = tmp();
    const bin = path.join(rt, 'collector');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 });
    startCollector(opts(rt, { binPath: bin }), fakeSpawn(5).fn);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  });

  it('throws (not crashes) when the process cannot be spawned', async () => {
    const rt = tmp();
    expect(() => startCollector(opts(rt), fakeSpawn(undefined).fn)).toThrow(/failed to start collector/);
    await new Promise((r) => setImmediate(r)); // the async 'error' event must have a listener
  });
});

describe('stopCollector', () => {
  function ops(aliveAfterSignals: number): ProcessOps & { signals: (string | number)[] } {
    const signals: (string | number)[] = [];
    return {
      signals,
      kill: (_pid, sig) => { signals.push(sig); },
      isAlive: () => signals.length < aliveAfterSignals || aliveAfterSignals === Infinity,
      sleep: async () => {},
    };
  }

  it('reports not-running when the process is gone', async () => {
    const o = ops(0);
    expect(await stopCollector(1, o)).toBe('not-running');
    expect(o.signals).toEqual([]);
  });

  it('stops with SIGTERM', async () => {
    const o = ops(1);
    expect(await stopCollector(1, o)).toBe('stopped');
    expect(o.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL after the timeout', async () => {
    const o = ops(Infinity);
    expect(await stopCollector(1, o, 200)).toBe('killed');
    expect(o.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/collector-control.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/collector-control.ts`:
```ts
import { ChildProcess, spawn as nodeSpawn, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StartOptions {
  binPath: string;
  runnerTemp: string;
  interval: number;
  processInterval: number;
  docker: boolean;
  watchPid: number | null;
  workspace?: string;
}

export interface StartResult { pid: number; dataDir: string; dataFile: string }
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export function collectorArgs(o: StartOptions, dataFile: string): string[] {
  const args = [
    '--out', dataFile,
    '--interval', String(o.interval),
    '--proc-interval', String(o.processInterval),
    '--docker', String(o.docker),
    '--watch-pid', String(o.watchPid ?? 0),
  ];
  if (o.workspace) args.push('--workspace', o.workspace);
  return args;
}

export function startCollector(o: StartOptions, spawnFn: SpawnFn = nodeSpawn): StartResult {
  // Unique per invocation so two uses of the action in one job never share a file.
  const dataDir = path.join(o.runnerTemp, 'ci-telemetry', randomBytes(4).toString('hex'));
  fs.mkdirSync(dataDir, { recursive: true });
  const dataFile = path.join(dataDir, 'samples.ndjson');
  try {
    fs.chmodSync(o.binPath, 0o755);
  } catch {
    // Read-only or missing: rely on the committed file mode; spawn reports the real error.
  }
  const child = spawnFn(o.binPath, collectorArgs(o, dataFile), { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // Without a listener an async spawn error would crash this step.
  });
  if (child.pid === undefined) throw new Error(`failed to start collector at ${o.binPath}`);
  child.unref();
  return { pid: child.pid, dataDir, dataFile };
}

export type StopResult = 'stopped' | 'killed' | 'not-running';

export interface ProcessOps {
  kill(pid: number, sig: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export const realProcessOps: ProcessOps = {
  kill: (pid, sig) => { process.kill(pid, sig); },
  isAlive: (pid) => {
    try {
      // A zombie (exited but unreaped, common in containers without an init) counts as gone.
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return s.charAt(s.lastIndexOf(')') + 2) !== 'Z';
    } catch {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function stopCollector(pid: number, ops: ProcessOps = realProcessOps, timeoutMs = 2000): Promise<StopResult> {
  if (!ops.isAlive(pid)) return 'not-running';
  try { ops.kill(pid, 'SIGTERM'); } catch { return 'not-running'; }
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    await ops.sleep(50);
    if (!ops.isAlive(pid)) return 'stopped';
  }
  try { ops.kill(pid, 'SIGKILL'); } catch { /* exited in the meantime */ }
  return 'killed';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/collector-control.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/collector-control.ts test/collector-control.test.ts
git commit -m "feat(action): start and stop the background collector"
```

---

### Task 9: Parsing the samples file

**Files:**
- Create: `src/samples.ts`, `test/fixtures.ts`
- Test: `test/samples.test.ts`

**Interfaces:**
- Consumes: `src/types.ts`
- Produces: `parseSamples(text: string): ParsedSamples`, `emptySamples(): ParsedSamples`; test helpers `T0`, `META`, `makeSample(t, overrides?)`, `makeEnd(t)`, `parsed(overrides?)`, `ndjson(records)`

- [ ] **Step 1: Write the fixture helpers**

`test/fixtures.ts`:
```ts
import { End, Meta, ParsedSamples, Sample } from '../src/types';

export const T0 = 1_759_050_000;

export const META: Meta = {
  type: 'meta', v: 1, t: T0, interval: 1, cpus: 2, mem_total: 8_000_000_000,
  kernel: '6.8.0-1015-azure', arch: 'x86_64', cgroup: 'v2',
  capabilities: { psi: true, docker_cgroups: true, docker_socket: true },
};

export function makeSample(t: number, o: Partial<Sample> = {}): Sample {
  return {
    type: 'sample', t,
    cpu: { usr: 10, sys: 5, iow: 0, steal: 0 },
    load1: 0.5,
    mem: { used: 1_000_000_000, avail: 7_000_000_000, cached: 500_000_000, swap: 0 },
    psi: { cpu_some: 1, mem_some: 0, mem_full: 0, io_some: 0, io_full: 0 },
    disk: { rd: 0, wr: 0 },
    net: { rx: 0, tx: 0 },
    ...o,
  };
}

export function makeEnd(t: number): End {
  return { type: 'end', t, reason: 'sigterm', self: { peak_rss: 1_800_000, cpu_seconds: 0.03 } };
}

export function parsed(o: Partial<ParsedSamples> = {}): ParsedSamples {
  return { meta: META, samples: [], containers: new Map(), downsamples: [], end: null, invalidLines: 0, ...o };
}

export function ndjson(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
```

- [ ] **Step 2: Write the failing tests**

`test/samples.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseSamples } from '../src/samples';
import { makeEnd, makeSample, META, ndjson, T0 } from './fixtures';

describe('parseSamples', () => {
  it('splits records by type and sorts samples by time', () => {
    const text = ndjson([
      META,
      makeSample(T0 + 2),
      makeSample(T0 + 1),
      { type: 'container', t: T0 + 1, id: 'abc', name: 'db', image: 'postgres:16' },
      { type: 'downsample', t: T0 + 3, interval: 2 },
      makeEnd(T0 + 4),
    ]);
    const p = parseSamples(text);
    expect(p.meta?.cpus).toBe(2);
    expect(p.samples.map((s) => s.t)).toEqual([T0 + 1, T0 + 2]);
    expect(p.containers.get('abc')).toEqual({ name: 'db', image: 'postgres:16' });
    expect(p.downsamples).toHaveLength(1);
    expect(p.end?.reason).toBe('sigterm');
    expect(p.invalidLines).toBe(0);
  });

  it('skips a truncated last line from a killed collector', () => {
    const text = ndjson([META, makeSample(T0 + 1)]) + '{"type":"sample","t":1759050002,"cpu":{"us';
    const p = parseSamples(text);
    expect(p.samples).toHaveLength(1);
    expect(p.end).toBeNull();
    expect(p.invalidLines).toBe(1);
  });

  it('rejects well-formed JSON with the wrong shape', () => {
    const p = parseSamples(ndjson([{ type: 'sample', t: 1 }, { type: 'bogus', t: 1 }, [1, 2], null, 'x']));
    expect(p.samples).toEqual([]);
    expect(p.invalidLines).toBe(5);
  });

  it('handles an empty file', () => {
    const p = parseSamples('');
    expect(p.meta).toBeNull();
    expect(p.samples).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/samples.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 4: Implement**

`src/samples.ts`:
```ts
import { ParsedSamples, Sample } from './types';

export function emptySamples(): ParsedSamples {
  return { meta: null, samples: [], containers: new Map(), downsamples: [], end: null, invalidLines: 0 };
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSample(r: Record<string, any>): r is Sample {
  return isObj(r.cpu) && isObj(r.mem) && isObj(r.disk) && isObj(r.net);
}

/** Tolerant NDJSON parse: malformed or unexpected lines are counted, never thrown. */
export function parseSamples(text: string): ParsedSamples {
  const out = emptySamples();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      out.invalidLines++;
      continue;
    }
    if (!isObj(rec) || typeof rec.t !== 'number') {
      out.invalidLines++;
      continue;
    }
    switch (rec.type) {
      case 'meta':
        out.meta = rec as ParsedSamples['meta'];
        break;
      case 'sample':
        if (isSample(rec)) out.samples.push(rec);
        else out.invalidLines++;
        break;
      case 'container':
        out.containers.set(String(rec.id), { name: String(rec.name), image: String(rec.image) });
        break;
      case 'downsample':
        out.downsamples.push(rec as ParsedSamples['downsamples'][number]);
        break;
      case 'end':
        out.end = rec as ParsedSamples['end'];
        break;
      default:
        out.invalidLines++;
    }
  }
  out.samples.sort((a, b) => a.t - b.t);
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/samples.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/samples.ts test/fixtures.ts test/samples.test.ts
git commit -m "feat(action): parse collector NDJSON tolerantly"
```

---

### Task 10: Step timings from the GitHub API

**Files:**
- Create: `src/steps.ts`
- Test: `test/steps.test.ts`

**Interfaces:**
- Consumes: `StepTiming`
- Produces: `ApiStep`, `ApiJob`, `StepsResult { steps: StepTiming[]|null; error?: string; jobName?: string; jobUrl?: string }`, `FetchStepsOptions { apiUrl; token; repository; runId; runAttempt; runnerName; jobStartedAt: number; timeoutMs?; fetchFn? }`, `selectCurrentJob(jobs, runnerName, jobStartedAt): ApiJob|null`, `toStepTimings(job): StepTiming[]`, `fetchSteps(o): Promise<StepsResult>` (never rejects)

- [ ] **Step 1: Write the failing tests**

`test/steps.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApiJob, fetchSteps, FetchStepsOptions, selectCurrentJob, toStepTimings } from '../src/steps';

const iso = (s: number) => new Date(s * 1000).toISOString();
const T = 1_759_050_000;

function job(o: Partial<ApiJob> = {}): ApiJob {
  return {
    id: 1, name: 'build', status: 'in_progress', runner_name: 'GitHub Actions 7', started_at: iso(T),
    html_url: 'https://github.com/o/r/actions/runs/9/job/1',
    steps: [
      { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success', started_at: iso(T), completed_at: iso(T + 2) },
      { name: 'Build', number: 2, status: 'completed', conclusion: 'success', started_at: iso(T + 2), completed_at: iso(T + 40) },
      { name: 'Deploy', number: 3, status: 'pending', conclusion: null, started_at: null, completed_at: null },
      { name: 'Post telemetry', number: 4, status: 'in_progress', conclusion: null, started_at: iso(T + 40), completed_at: null },
    ],
    ...o,
  };
}

const opts = (fetchFn: any, o: Partial<FetchStepsOptions> = {}): FetchStepsOptions => ({
  apiUrl: 'https://api.github.com', token: 't', repository: 'o/r', runId: '9', runAttempt: '1',
  runnerName: 'GitHub Actions 7', jobStartedAt: T, fetchFn, ...o,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('toStepTimings', () => {
  it('converts to epoch seconds and drops steps that never started', () => {
    expect(toStepTimings(job())).toEqual([
      { name: 'Set up job', number: 1, conclusion: 'success', started_at: T, completed_at: T + 2 },
      { name: 'Build', number: 2, conclusion: 'success', started_at: T + 2, completed_at: T + 40 },
      { name: 'Post telemetry', number: 4, conclusion: null, started_at: T + 40, completed_at: null },
    ]);
  });
});

describe('selectCurrentJob', () => {
  it('matches in-progress job on this runner, closest start wins', () => {
    const jobs = [
      job({ id: 1, runner_name: 'other' }),
      job({ id: 2, status: 'completed' }),
      job({ id: 3, started_at: iso(T - 500) }),
      job({ id: 4, started_at: iso(T - 3) }),
    ];
    expect(selectCurrentJob(jobs, 'GitHub Actions 7', T)?.id).toBe(4);
    expect(selectCurrentJob(jobs, 'nobody', T)).toBeNull();
  });
});

describe('fetchSteps', () => {
  it('fetches, authenticates and returns steps', async () => {
    const urls: string[] = [];
    const r = await fetchSteps(opts(async (url: string, init: any) => {
      urls.push(url);
      expect(init.headers.authorization).toBe('Bearer t');
      return json({ total_count: 1, jobs: [job()] });
    }));
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/actions/runs/9/attempts/1/jobs?per_page=100&page=1');
    expect(r.steps).toHaveLength(3);
    expect(r.jobName).toBe('build');
    expect(r.error).toBeUndefined();
  });

  it('follows pagination', async () => {
    const others = Array.from({ length: 100 }, (_, i) => job({ id: 100 + i, runner_name: `r${i}` }));
    const r = await fetchSteps(opts(async (url: string) =>
      url.endsWith('page=1') ? json({ total_count: 101, jobs: others }) : json({ total_count: 101, jobs: [job({ id: 7 })] })));
    expect(r.steps).not.toBeNull();
  });

  it('reports HTTP errors without throwing', async () => {
    const r = await fetchSteps(opts(async () => json({ message: 'Resource not accessible by integration' }, 403)));
    expect(r.steps).toBeNull();
    expect(r.error).toContain('403');
  });

  it('reports network errors and missing tokens without throwing', async () => {
    const r1 = await fetchSteps(opts(async () => { throw new Error('ECONNRESET'); }));
    expect(r1).toEqual({ steps: null, error: 'could not fetch step timings: ECONNRESET' });
    const r2 = await fetchSteps(opts(async () => json({}), { token: '' }));
    expect(r2.error).toBe('no github-token available');
  });

  it('reports when no job matches', async () => {
    const r = await fetchSteps(opts(async () => json({ total_count: 1, jobs: [job({ runner_name: 'x' })] })));
    expect(r.error).toContain("no in-progress job found for runner 'GitHub Actions 7'");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/steps.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/steps.ts`:
```ts
import { StepTiming } from './types';

export interface ApiStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface ApiJob {
  id: number;
  name: string;
  status: string;
  runner_name: string | null;
  started_at: string;
  html_url: string;
  steps?: ApiStep[];
}

export interface StepsResult {
  steps: StepTiming[] | null;
  error?: string;
  jobName?: string;
  jobUrl?: string;
}

export interface FetchStepsOptions {
  apiUrl: string;
  token: string;
  repository: string;
  runId: string;
  runAttempt: string;
  runnerName: string;
  jobStartedAt: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const toEpoch = (iso: string | null): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? null : v / 1000;
};

export function selectCurrentJob(jobs: ApiJob[], runnerName: string, jobStartedAt: number): ApiJob | null {
  const candidates = jobs.filter((j) => j.status === 'in_progress' && j.runner_name === runnerName);
  if (candidates.length === 0) return null;
  const gap = (j: ApiJob) => Math.abs((toEpoch(j.started_at) ?? 0) - jobStartedAt);
  return candidates.reduce((best, j) => (gap(j) < gap(best) ? j : best));
}

/** Steps that never started (skipped/pending with no start time) are dropped. */
export function toStepTimings(job: ApiJob): StepTiming[] {
  return (job.steps ?? [])
    .flatMap((s) => {
      const start = toEpoch(s.started_at);
      if (start === null) return [];
      return [{ name: s.name, number: s.number, conclusion: s.conclusion, started_at: start, completed_at: toEpoch(s.completed_at) }];
    })
    .sort((a, b) => a.number - b.number);
}

/** One paginated call during post. Never rejects: failures come back as `error`. */
export async function fetchSteps(o: FetchStepsOptions): Promise<StepsResult> {
  if (!o.token) return { steps: null, error: 'no github-token available' };
  const fetchFn = o.fetchFn ?? fetch;
  const jobs: ApiJob[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const url = `${o.apiUrl}/repos/${o.repository}/actions/runs/${o.runId}/attempts/${o.runAttempt}/jobs?per_page=100&page=${page}`;
      const res = await fetchFn(url, {
        headers: {
          authorization: `Bearer ${o.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ci-telemetry',
        },
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        return { steps: null, error: `GitHub API returned ${res.status} when listing jobs (does the token have actions: read?)` };
      }
      const body = (await res.json()) as { total_count: number; jobs: ApiJob[] };
      jobs.push(...body.jobs);
      if (jobs.length >= body.total_count || body.jobs.length < 100) break;
    }
  } catch (e) {
    return { steps: null, error: `could not fetch step timings: ${(e as Error).message}` };
  }
  const job = selectCurrentJob(jobs, o.runnerName, o.jobStartedAt);
  if (!job) return { steps: null, error: `no in-progress job found for runner '${o.runnerName}'` };
  return { steps: toStepTimings(job), jobName: job.name, jobUrl: job.html_url };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/steps.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/steps.ts test/steps.test.ts
git commit -m "feat(action): fetch per-step timings from the jobs API"
```

---

### Task 11: OOM detection

**Files:**
- Create: `src/oom.ts`
- Test: `test/oom.test.ts`

**Interfaces:**
- Consumes: `ParsedSamples`, `Sample`, `StopResult`
- Produces: `OomEvent { t: number; process: string; pid: number|null; source: 'kernel'|'container'|'collector'; step: string|null }`, `parseDmesgTimestamp(s): number|null`, `parseDmesg(text, from, to): OomEvent[]`, `readDmesg(run?): Promise<string|null>`, `containerOomEvents(samples, names): OomEvent[]`, `collectorOomEvent(p, stop: StopResult|'not-started'): OomEvent[]`

- [ ] **Step 1: Write the failing tests**

`test/oom.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { collectorOomEvent, containerOomEvents, parseDmesg, parseDmesgTimestamp, readDmesg } from '../src/oom';
import { makeEnd, makeSample, parsed, T0 } from './fixtures';

const ID = 'c'.repeat(64);
const ctr = (oom: number) => [{ id: ID, cpu: 0, mem: 1, mem_peak: null, io_rd: 0, io_wr: 0, oom_kills: oom }];
const ts = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', ',123456+00:00');

describe('parseDmesgTimestamp', () => {
  it('parses util-linux iso format with comma fraction and offsets', () => {
    expect(parseDmesgTimestamp('2025-09-28T10:03:41,123456+00:00')).toBe(Date.parse('2025-09-28T10:03:41.123Z') / 1000);
    expect(parseDmesgTimestamp('2025-09-28T12:03:41,000000+0200')).toBe(Date.parse('2025-09-28T10:03:41Z') / 1000);
    expect(parseDmesgTimestamp('[  12.3]')).toBeNull();
  });
});

describe('parseDmesg', () => {
  it('extracts global and cgroup OOM kills inside the window', () => {
    const text = [
      `${ts(T0 - 100)} Out of memory: Killed process 11 (old) total-vm:1kB`,
      `${ts(T0 + 5)} oom-kill:constraint=CONSTRAINT_NONE,task=node,pid=22,uid=1001`,
      `${ts(T0 + 5)} Out of memory: Killed process 22 (node) total-vm:4096kB, anon-rss:2048kB`,
      `${ts(T0 + 9)} Memory cgroup out of memory: Killed process 33 (python3) total-vm:1kB`,
      `${ts(T0 + 9)} eth0: link up`,
    ].join('\n');
    const ev = parseDmesg(text, T0, T0 + 60);
    expect(ev.map((e) => [e.process, e.pid, e.source])).toEqual([['node', 22, 'kernel'], ['python3', 33, 'kernel']]);
    expect(ev[0].t).toBeCloseTo(T0 + 5.123, 3);
  });
});

describe('readDmesg', () => {
  it('returns stdout, or null when sudo/dmesg is unavailable', async () => {
    expect(await readDmesg(async () => ({ stdout: 'x' }))).toBe('x');
    expect(await readDmesg(async () => { throw new Error('sudo: a password is required'); })).toBeNull();
  });
});

describe('containerOomEvents', () => {
  it('emits one event per increase in a container kill count', () => {
    const samples = [makeSample(T0 + 1, { ctr: ctr(0) }), makeSample(T0 + 3, { ctr: ctr(1) }), makeSample(T0 + 5, { ctr: ctr(1) }), makeSample(T0 + 7, { ctr: ctr(2) })];
    const ev = containerOomEvents(samples, new Map([[ID, { name: 'db', image: 'postgres:16' }]]));
    expect(ev.map((e) => [e.t, e.process, e.source])).toEqual([[T0 + 3, 'db', 'container'], [T0 + 7, 'db', 'container']]);
  });
  it('falls back to the short id when the name is unknown', () => {
    expect(containerOomEvents([makeSample(T0, { ctr: ctr(1) })], new Map())[0].process).toBe('c'.repeat(12));
  });
});

describe('collectorOomEvent', () => {
  it('flags a collector that died before post stopped it', () => {
    const p = parsed({ samples: [makeSample(T0 + 1), makeSample(T0 + 2)] });
    expect(collectorOomEvent(p, 'not-running')).toEqual([{ t: T0 + 2, process: 'ci-telemetry collector', pid: null, source: 'collector', step: null }]);
  });
  it('does not flag a normal stop, a SIGKILL by post, or a collector that never started', () => {
    expect(collectorOomEvent(parsed({ samples: [makeSample(T0)], end: makeEnd(T0 + 1) }), 'stopped')).toEqual([]);
    expect(collectorOomEvent(parsed({ samples: [makeSample(T0)] }), 'killed')).toEqual([]);
    expect(collectorOomEvent(parsed(), 'not-running')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/oom.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/oom.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StopResult } from './collector-control';
import { ParsedSamples, Sample } from './types';

export interface OomEvent {
  t: number;
  process: string;
  pid: number | null;
  source: 'kernel' | 'container' | 'collector';
  step: string | null;
}

// Matches global ("Out of memory: …") and cgroup ("Memory cgroup out of memory: …") kills.
// The companion "oom-kill:" info line is ignored to avoid double counting.
const KILLED = /(?:Memory cgroup )?[Oo]ut of memory: Killed process (\d+) \(([^)]*)\)/;
const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[,.](\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseDmesgTimestamp(s: string): number | null {
  const m = ISO.exec(s);
  if (!m) return null;
  const frac = m[2] ? `.${m[2].slice(0, 3).padEnd(3, '0')}` : '';
  let tz = m[3] ?? 'Z';
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const v = Date.parse(`${m[1]}${frac}${tz}`);
  return Number.isNaN(v) ? null : v / 1000;
}

export function parseDmesg(text: string, from: number, to: number): OomEvent[] {
  const out: OomEvent[] = [];
  for (const line of text.split('\n')) {
    const k = KILLED.exec(line);
    if (!k) continue;
    const t = parseDmesgTimestamp(line.split(/\s+/, 1)[0]);
    if (t === null || t < from || t > to) continue;
    out.push({ t, process: k[2], pid: Number(k[1]), source: 'kernel', step: null });
  }
  return out;
}

type Runner = (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
const execFileP = promisify(execFile) as unknown as Runner;

/** Kernel log via passwordless sudo; null when not permitted or not available. */
export async function readDmesg(run: Runner = execFileP): Promise<string | null> {
  try {
    const { stdout } = await run('sudo', ['-n', 'dmesg', '--time-format', 'iso'], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

export function containerOomEvents(samples: Sample[], names: Map<string, { name: string }>): OomEvent[] {
  const last = new Map<string, number>();
  const out: OomEvent[] = [];
  for (const s of samples) {
    for (const c of s.ctr ?? []) {
      if (c.oom_kills > (last.get(c.id) ?? 0)) {
        out.push({ t: s.t, process: names.get(c.id)?.name ?? c.id.slice(0, 12), pid: null, source: 'container', step: null });
      }
      last.set(c.id, c.oom_kills);
    }
  }
  return out;
}

/** The collector has oom_score_adj 1000: if it vanished before post, memory ran out. */
export function collectorOomEvent(p: ParsedSamples, stop: StopResult | 'not-started'): OomEvent[] {
  if (stop !== 'not-running' || p.end !== null || p.samples.length === 0) return [];
  return [{ t: p.samples[p.samples.length - 1].t, process: 'ci-telemetry collector', pid: null, source: 'collector', step: null }];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/oom.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/oom.ts test/oom.test.ts
git commit -m "feat(action): detect OOM kills from dmesg, cgroups and collector death"
```

---

### Task 12: Formatting helpers and aggregation

**Files:**
- Create: `src/format.ts`, `src/aggregate.ts`
- Test: `test/format.test.ts`, `test/aggregate.test.ts`

**Interfaces:**
- Consumes: `ParsedSamples`, `Sample`, `StepTiming`
- Produces (`format.ts`): `iso(t): string`, `round1(x)`, `round2(x)`, `formatBytes(n): string`, `formatDuration(s): string`, `pct(v: number|null): string`
- Produces (`aggregate.ts`): `PsiMax`, `StepStats { name; number; conclusion; started_at: string; completed_at: string|null; duration_s; samples; cpu_avg; cpu_max; mem_peak; psi_max: PsiMax|null; disk_rd; disk_wr; net_rx; net_tx }`, `ContainerStats { id; name; image: string|null; first_seen: string; last_seen: string; cpu_avg; cpu_max; mem_peak; oom_kills }`, `JobTotals { duration_s; samples; cpu_avg; cpu_max; mem_peak; steal_avg; psi_max; min_root_free; min_ws_free; swap_start; swap_max }`, `stepAt(t, steps): StepTiming|null`, `aggregateSteps(p, steps): StepStats[]`, `aggregateContainers(p): ContainerStats[]`, `jobTotals(p): JobTotals`

- [ ] **Step 1: Write the failing tests**

`test/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, iso, pct } from '../src/format';

describe('format', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
  });
  it('formats durations', () => {
    expect(formatDuration(42.4)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 7m');
  });
  it('formats percentages and nulls', () => {
    expect(pct(12.345)).toBe('12.3%');
    expect(pct(null)).toBe('–');
  });
  it('formats epoch seconds as ISO', () => {
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});
```

`test/aggregate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { aggregateContainers, aggregateSteps, jobTotals, stepAt } from '../src/aggregate';
import { StepTiming } from '../src/types';
import { makeEnd, makeSample, parsed, T0 } from './fixtures';

const steps: StepTiming[] = [
  { name: 'Set up job', number: 1, conclusion: 'success', started_at: T0 - 10, completed_at: T0 - 5 },
  { name: 'Build', number: 2, conclusion: 'success', started_at: T0, completed_at: T0 + 3 },
  { name: 'Post telemetry', number: 3, conclusion: null, started_at: T0 + 3, completed_at: null },
];

const samples = [
  makeSample(T0 + 1, { cpu: { usr: 10, sys: 0, iow: 0, steal: 0 }, disk: { rd: 1000, wr: 0 }, mem: { used: 1e9, avail: 1, cached: 1, swap: 0 } }),
  makeSample(T0 + 2, { cpu: { usr: 30, sys: 0, iow: 0, steal: 2 }, disk: { rd: 1000, wr: 0 }, mem: { used: 2e9, avail: 1, cached: 1, swap: 0 }, psi: { cpu_some: 5, mem_some: 20, mem_full: 12, io_some: 0, io_full: 0 } }),
  makeSample(T0 + 3, { disk: { rd: 1000, wr: 0 }, fs: { root_free: 5e9, ws_free: 4e9 } }),
  makeSample(T0 + 4, { disk: { rd: 1000, wr: 0 }, mem: { used: 1e9, avail: 1, cached: 1, swap: 4096 } }),
  makeSample(T0 + 5, { disk: { rd: 1000, wr: 0 }, fs: { root_free: 3e9, ws_free: null } }),
];

describe('stepAt', () => {
  it('uses half-open ranges and open-ended in-progress steps', () => {
    expect(stepAt(T0, steps)?.name).toBe('Build');
    expect(stepAt(T0 + 3, steps)?.name).toBe('Post telemetry');
    expect(stepAt(T0 + 999, steps)?.name).toBe('Post telemetry');
    expect(stepAt(T0 - 2, steps)).toBeNull();
  });
});

describe('aggregateSteps', () => {
  const stats = aggregateSteps(parsed({ samples }), steps);

  it('gives steps before the collector started a duration but no metrics', () => {
    expect(stats[0]).toMatchObject({ name: 'Set up job', duration_s: 5, samples: 0, cpu_avg: null, mem_peak: null, psi_max: null, disk_rd: 0 });
  });

  it('summarises samples inside a step', () => {
    expect(stats[1]).toMatchObject({
      name: 'Build', duration_s: 3, samples: 2, cpu_avg: 20, cpu_max: 30, mem_peak: 2e9, disk_rd: 2000,
      started_at: new Date(T0 * 1000).toISOString(),
    });
    expect(stats[1].psi_max).toEqual({ cpu_some: 5, mem_some: 20, mem_full: 12, io_some: 0, io_full: 0 });
  });

  it('assigns trailing samples to the in-progress step', () => {
    expect(stats[2]).toMatchObject({ samples: 3, duration_s: 2, completed_at: null, disk_rd: 3000 });
  });
});

describe('aggregateContainers', () => {
  it('summarises per container with names from container records', () => {
    const id = 'c'.repeat(64);
    const c = (cpu: number, mem: number, peak: number | null, oom: number) => [{ id, cpu, mem, mem_peak: peak, io_rd: 0, io_wr: 0, oom_kills: oom }];
    const p = parsed({
      samples: [makeSample(T0 + 1, { ctr: c(10, 100, null, 0) }), makeSample(T0 + 3, { ctr: c(30, 300, 350, 1) })],
      containers: new Map([[id, { name: 'db', image: 'postgres:16' }]]),
    });
    expect(aggregateContainers(p)).toEqual([{
      id, name: 'db', image: 'postgres:16', first_seen: new Date((T0 + 1) * 1000).toISOString(),
      last_seen: new Date((T0 + 3) * 1000).toISOString(), cpu_avg: 20, cpu_max: 30, mem_peak: 350, oom_kills: 1,
    }]);
  });
});

describe('jobTotals', () => {
  it('computes whole-job figures', () => {
    const t = jobTotals(parsed({ samples, end: makeEnd(T0 + 6) }));
    expect(t).toMatchObject({ duration_s: 6, samples: 5, cpu_max: 30, mem_peak: 2e9, steal_avg: 0.4, min_root_free: 3e9, min_ws_free: 4e9, swap_start: 0, swap_max: 4096 });
  });
  it('handles no samples', () => {
    expect(jobTotals(parsed())).toMatchObject({ samples: 0, cpu_avg: null, mem_peak: null, swap_start: null });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/format.test.ts test/aggregate.test.ts`
Expected: FAIL, the modules can't be resolved.

- [ ] **Step 3: Implement**

`src/format.ts`:
```ts
export const iso = (t: number): string => new Date(t * 1000).toISOString();
export const round1 = (x: number): number => Math.round(x * 10) / 10;
export const round2 = (x: number): number => Math.round(x * 100) / 100;

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const pct = (v: number | null): string => (v === null ? '–' : `${v.toFixed(1)}%`);
```

`src/aggregate.ts`:
```ts
import { iso, round1 } from './format';
import { ParsedSamples, Sample, StepTiming } from './types';

export interface PsiMax {
  cpu_some: number | null;
  mem_some: number | null;
  mem_full: number | null;
  io_some: number | null;
  io_full: number | null;
}

export interface StepStats {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  duration_s: number;
  samples: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_peak: number | null;
  psi_max: PsiMax | null;
  disk_rd: number;
  disk_wr: number;
  net_rx: number;
  net_tx: number;
}

export interface ContainerStats {
  id: string;
  name: string;
  image: string | null;
  first_seen: string;
  last_seen: string;
  cpu_avg: number;
  cpu_max: number;
  mem_peak: number;
  oom_kills: number;
}

export interface JobTotals {
  duration_s: number;
  samples: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_peak: number | null;
  steal_avg: number | null;
  psi_max: PsiMax | null;
  min_root_free: number | null;
  min_ws_free: number | null;
  swap_start: number | null;
  swap_max: number | null;
}

const busy = (s: Sample) => s.cpu.usr + s.cpu.sys;
const inStep = (t: number, s: StepTiming) => t >= s.started_at && (s.completed_at === null || t < s.completed_at);

export function stepAt(t: number, steps: StepTiming[]): StepTiming | null {
  return steps.find((s) => inStep(t, s)) ?? null;
}

function extreme(vals: Array<number | null | undefined>, pick: (a: number, b: number) => number): number | null {
  let m: number | null = null;
  for (const v of vals) if (typeof v === 'number') m = m === null ? v : pick(m, v);
  return m;
}
const maxOf = (vals: Array<number | null | undefined>) => extreme(vals, Math.max);
const minOf = (vals: Array<number | null | undefined>) => extreme(vals, Math.min);
const avgOf = (vals: number[]) => (vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null);

function psiMax(samples: Sample[]): PsiMax | null {
  if (!samples.some((s) => s.psi)) return null;
  const k = (f: keyof PsiMax) => maxOf(samples.map((s) => s.psi?.[f]));
  return { cpu_some: k('cpu_some'), mem_some: k('mem_some'), mem_full: k('mem_full'), io_some: k('io_some'), io_full: k('io_full') };
}

/** Seconds each sample represents: the gap since the previous one (the interval for the first). */
function sampleDurations(p: ParsedSamples): number[] {
  const first = p.meta?.interval ?? 1;
  return p.samples.map((s, i) => (i === 0 ? first : s.t - p.samples[i - 1].t));
}

function totalOf(samples: Sample[], dts: number[], f: (s: Sample) => number): number {
  return Math.round(samples.reduce((acc, s, i) => acc + f(s) * dts[i], 0));
}

export function aggregateSteps(p: ParsedSamples, steps: StepTiming[]): StepStats[] {
  const dts = sampleDurations(p);
  const lastT = p.samples.length ? p.samples[p.samples.length - 1].t : null;
  return steps.map((step) => {
    const idx = p.samples.flatMap((s, i) => (inStep(s.t, step) ? [i] : []));
    const ss = idx.map((i) => p.samples[i]);
    const ds = idx.map((i) => dts[i]);
    const end = step.completed_at ?? lastT ?? step.started_at;
    return {
      name: step.name,
      number: step.number,
      conclusion: step.conclusion,
      started_at: iso(step.started_at),
      completed_at: step.completed_at === null ? null : iso(step.completed_at),
      duration_s: round1(Math.max(0, end - step.started_at)),
      samples: ss.length,
      cpu_avg: avgOf(ss.map(busy)),
      cpu_max: maxOf(ss.map(busy)),
      mem_peak: maxOf(ss.map((s) => s.mem.used)),
      psi_max: psiMax(ss),
      disk_rd: totalOf(ss, ds, (s) => s.disk.rd),
      disk_wr: totalOf(ss, ds, (s) => s.disk.wr),
      net_rx: totalOf(ss, ds, (s) => s.net.rx),
      net_tx: totalOf(ss, ds, (s) => s.net.tx),
    };
  });
}

export function aggregateContainers(p: ParsedSamples): ContainerStats[] {
  const acc = new Map<string, { first: number; last: number; cpus: number[]; mem: number; oom: number }>();
  for (const s of p.samples) {
    for (const c of s.ctr ?? []) {
      const a = acc.get(c.id) ?? { first: s.t, last: s.t, cpus: [], mem: 0, oom: 0 };
      a.last = s.t;
      a.cpus.push(c.cpu);
      a.mem = Math.max(a.mem, c.mem_peak ?? c.mem, c.mem);
      a.oom = Math.max(a.oom, c.oom_kills);
      acc.set(c.id, a);
    }
  }
  return [...acc.entries()].map(([id, a]) => {
    const info = p.containers.get(id);
    return {
      id,
      name: info?.name ?? id.slice(0, 12),
      image: info?.image ?? null,
      first_seen: iso(a.first),
      last_seen: iso(a.last),
      cpu_avg: avgOf(a.cpus) ?? 0,
      cpu_max: maxOf(a.cpus) ?? 0,
      mem_peak: a.mem,
      oom_kills: a.oom,
    };
  });
}

export function jobTotals(p: ParsedSamples): JobTotals {
  const s = p.samples;
  const start = p.meta?.t ?? s[0]?.t ?? 0;
  const end = p.end?.t ?? s[s.length - 1]?.t ?? start;
  return {
    duration_s: round1(Math.max(0, end - start)),
    samples: s.length,
    cpu_avg: avgOf(s.map(busy)),
    cpu_max: maxOf(s.map(busy)),
    mem_peak: maxOf(s.map((x) => x.mem.used)),
    steal_avg: avgOf(s.map((x) => x.cpu.steal)),
    psi_max: psiMax(s),
    min_root_free: minOf(s.map((x) => x.fs?.root_free)),
    min_ws_free: minOf(s.map((x) => x.fs?.ws_free)),
    swap_start: s.length ? s[0].mem.swap : null,
    swap_max: maxOf(s.map((x) => x.mem.swap)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/format.test.ts test/aggregate.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts src/aggregate.ts test/format.test.ts test/aggregate.test.ts
git commit -m "feat(action): aggregate samples per step, per container and per job"
```

---

### Task 13: Findings

**Files:**
- Create: `src/findings.ts`
- Test: `test/findings.test.ts`

**Interfaces:**
- Consumes: `StepStats`, `JobTotals`, `OomEvent`, `formatBytes`, `iso`
- Produces: `Finding { level: 'error'|'warning'; code: string; message: string; step: string|null }`, `THRESHOLDS`, `computeFindings({ steps, totals, oom }): Finding[]`

- [ ] **Step 1: Write the failing tests**

`test/findings.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { JobTotals, StepStats } from '../src/aggregate';
import { computeFindings } from '../src/findings';

const totals = (o: Partial<JobTotals> = {}): JobTotals => ({
  duration_s: 100, samples: 100, cpu_avg: 10, cpu_max: 20, mem_peak: 1, steal_avg: 0, psi_max: null,
  min_root_free: 50 * 1024 ** 3, min_ws_free: null, swap_start: 0, swap_max: 0, ...o,
});

const step = (o: Partial<StepStats> = {}): StepStats => ({
  name: 'Test', number: 3, conclusion: 'success', started_at: '', completed_at: '', duration_s: 60, samples: 60,
  cpu_avg: 10, cpu_max: 20, mem_peak: 1, psi_max: { cpu_some: 0, mem_some: 0, mem_full: 0, io_some: 0, io_full: 0 },
  disk_rd: 0, disk_wr: 0, net_rx: 0, net_tx: 0, ...o,
});

const codes = (f: ReturnType<typeof computeFindings>) => f.map((x) => `${x.level}:${x.code}`);

describe('computeFindings', () => {
  it('is empty for a healthy job', () => {
    expect(computeFindings({ steps: [step()], totals: totals(), oom: [] })).toEqual([]);
  });

  it('flags step bottlenecks at the thresholds', () => {
    const f = computeFindings({
      steps: [step({ cpu_avg: 90, psi_max: { cpu_some: 0, mem_some: 0, mem_full: 10, io_some: 0, io_full: 20 } })],
      totals: totals(), oom: [],
    });
    expect(codes(f)).toEqual(['warning:memory-starved', 'warning:cpu-bound', 'warning:io-bound']);
    expect(f[0].message).toBe('Step "Test" was memory-starved (memory pressure peaked at 10.0%); the runner is probably undersized');
    expect(f[0].step).toBe('Test');
  });

  it('ignores short steps and steps without samples', () => {
    const hot = { cpu_avg: 99 };
    expect(computeFindings({ steps: [step({ ...hot, duration_s: 29 }), step({ ...hot, samples: 0 })], totals: totals(), oom: [] })).toEqual([]);
  });

  it('flags job-level steal, low disk and swapping', () => {
    const f = computeFindings({ steps: null, totals: totals({ steal_avg: 5, min_ws_free: 512 * 1024 ** 2, swap_max: 4096 }), oom: [] });
    expect(codes(f)).toEqual(['warning:steal', 'warning:disk-full', 'warning:swap']);
    expect(f[1].message).toBe('Disk nearly full: only 512.0 MiB free at the lowest point');
  });

  it('reports OOM events first, as errors', () => {
    const f = computeFindings({
      steps: [step({ cpu_avg: 95 })], totals: totals(),
      oom: [
        { t: 0, process: 'node', pid: 22, source: 'kernel', step: 'Build' },
        { t: 1, process: 'db', pid: null, source: 'container', step: null },
        { t: 2, process: 'ci-telemetry collector', pid: null, source: 'collector', step: 'Build' },
      ],
    });
    expect(codes(f).slice(0, 3)).toEqual(['error:oom', 'error:oom', 'error:oom']);
    expect(f[0].message).toBe('OOM kill of node (pid 22) during step "Build"');
    expect(f[1].message).toBe('Container db was OOM-killed');
    expect(f[2].message).toContain('collector was terminated early');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/findings.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/findings.ts`:
```ts
import { JobTotals, StepStats } from './aggregate';
import { formatBytes, iso } from './format';
import { OomEvent } from './oom';

export interface Finding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  step: string | null;
}

export const THRESHOLDS = {
  minStepSeconds: 30,
  memFullPct: 10,
  cpuBusyPct: 90,
  ioFullPct: 20,
  stealPct: 5,
  minFreeBytes: 1024 ** 3,
} as const;

function oomMessage(e: OomEvent): string {
  const where = e.step ? ` during step "${e.step}"` : '';
  if (e.source === 'collector') {
    return `The telemetry collector was terminated early at ${iso(e.t)}${where} (most likely OOM-killed); later data is missing`;
  }
  if (e.source === 'container') return `Container ${e.process} was OOM-killed${where}`;
  return `OOM kill of ${e.process} (pid ${e.pid})${where}`;
}

export function computeFindings(i: { steps: StepStats[] | null; totals: JobTotals; oom: OomEvent[] }): Finding[] {
  const out: Finding[] = i.oom.map((e) => ({ level: 'error', code: 'oom', message: oomMessage(e), step: e.step }));
  const warn = (code: string, message: string, step: string | null = null) => out.push({ level: 'warning', code, message, step });

  for (const s of i.steps ?? []) {
    if (s.duration_s < THRESHOLDS.minStepSeconds || s.samples === 0) continue;
    const memFull = s.psi_max?.mem_full ?? 0;
    const ioFull = s.psi_max?.io_full ?? 0;
    if (memFull >= THRESHOLDS.memFullPct) {
      warn('memory-starved', `Step "${s.name}" was memory-starved (memory pressure peaked at ${memFull.toFixed(1)}%); the runner is probably undersized`, s.name);
    }
    if ((s.cpu_avg ?? 0) >= THRESHOLDS.cpuBusyPct) {
      warn('cpu-bound', `Step "${s.name}" was CPU-bound (average CPU ${(s.cpu_avg ?? 0).toFixed(1)}%)`, s.name);
    }
    if (ioFull >= THRESHOLDS.ioFullPct) {
      warn('io-bound', `Step "${s.name}" was I/O-bound (I/O pressure peaked at ${ioFull.toFixed(1)}%)`, s.name);
    }
  }

  const t = i.totals;
  if ((t.steal_avg ?? 0) >= THRESHOLDS.stealPct) {
    warn('steal', `CPU steal averaged ${(t.steal_avg ?? 0).toFixed(1)}%: the host is contended (noisy neighbour)`);
  }
  const frees = [t.min_root_free, t.min_ws_free].filter((v): v is number => v !== null);
  if (frees.length && Math.min(...frees) < THRESHOLDS.minFreeBytes) {
    warn('disk-full', `Disk nearly full: only ${formatBytes(Math.min(...frees))} free at the lowest point`);
  }
  if (t.swap_start !== null && t.swap_max !== null && t.swap_max > t.swap_start) {
    warn('swap', `The runner started swapping (swap use grew by ${formatBytes(t.swap_max - t.swap_start)})`);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/findings.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/findings.ts test/findings.test.ts
git commit -m "feat(action): derive findings from step and job figures"
```

---

### Task 14: Report assembly and JSON Schema

**Files:**
- Create: `src/report.ts`, `schema/report.schema.json`
- Modify: `test/fixtures.ts` (add `makeReport`)
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `aggregate.*`, `findings.computeFindings`, `oom.*`, `StepsResult`, `StopResult`, `format.*`
- Produces: `Report` (shape below), `BuildReportInput { parsed; steps: StepsResult; dmesg: string|null; stopResult: StopResult|'not-started'; env: Record<string,string|undefined>; now: number }`, `buildReport(i): Report`; test helper `makeReport(): { report: Report; samples: Sample[] }`

- [ ] **Step 1: Write the schema**

`schema/report.schema.json`:
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ci-telemetry report",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "generated_at", "job", "runner", "capabilities", "steps", "totals", "containers", "oom_events", "findings", "collector"],
  "definitions": {
    "nnum": { "type": ["number", "null"] },
    "nstr": { "type": ["string", "null"] },
    "psiMax": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["cpu_some", "mem_some", "mem_full", "io_some", "io_full"],
      "properties": {
        "cpu_some": { "$ref": "#/definitions/nnum" },
        "mem_some": { "$ref": "#/definitions/nnum" },
        "mem_full": { "$ref": "#/definitions/nnum" },
        "io_some": { "$ref": "#/definitions/nnum" },
        "io_full": { "$ref": "#/definitions/nnum" }
      }
    },
    "step": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "number", "conclusion", "started_at", "completed_at", "duration_s", "samples", "cpu_avg", "cpu_max", "mem_peak", "psi_max", "disk_rd", "disk_wr", "net_rx", "net_tx"],
      "properties": {
        "name": { "type": "string" },
        "number": { "type": "integer" },
        "conclusion": { "$ref": "#/definitions/nstr" },
        "started_at": { "type": "string" },
        "completed_at": { "$ref": "#/definitions/nstr" },
        "duration_s": { "type": "number", "minimum": 0 },
        "samples": { "type": "integer", "minimum": 0 },
        "cpu_avg": { "$ref": "#/definitions/nnum" },
        "cpu_max": { "$ref": "#/definitions/nnum" },
        "mem_peak": { "$ref": "#/definitions/nnum" },
        "psi_max": { "$ref": "#/definitions/psiMax" },
        "disk_rd": { "type": "number" },
        "disk_wr": { "type": "number" },
        "net_rx": { "type": "number" },
        "net_tx": { "type": "number" }
      }
    },
    "container": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "name", "image", "first_seen", "last_seen", "cpu_avg", "cpu_max", "mem_peak", "oom_kills"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "image": { "$ref": "#/definitions/nstr" },
        "first_seen": { "type": "string" },
        "last_seen": { "type": "string" },
        "cpu_avg": { "type": "number" },
        "cpu_max": { "type": "number" },
        "mem_peak": { "type": "number" },
        "oom_kills": { "type": "integer", "minimum": 0 }
      }
    },
    "oom": {
      "type": "object",
      "additionalProperties": false,
      "required": ["t", "process", "pid", "source", "step"],
      "properties": {
        "t": { "type": "number" },
        "process": { "type": "string" },
        "pid": { "type": ["integer", "null"] },
        "source": { "enum": ["kernel", "container", "collector"] },
        "step": { "$ref": "#/definitions/nstr" }
      }
    },
    "finding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "code", "message", "step"],
      "properties": {
        "level": { "enum": ["error", "warning"] },
        "code": { "type": "string" },
        "message": { "type": "string" },
        "step": { "$ref": "#/definitions/nstr" }
      }
    }
  },
  "properties": {
    "schema_version": { "const": 1 },
    "generated_at": { "type": "string" },
    "job": {
      "type": "object",
      "additionalProperties": false,
      "required": ["repository", "workflow", "job", "job_name", "run_id", "run_attempt", "sha", "ref", "runner_name", "url"],
      "properties": {
        "repository": { "type": "string" },
        "workflow": { "type": "string" },
        "job": { "type": "string" },
        "job_name": { "$ref": "#/definitions/nstr" },
        "run_id": { "type": "string" },
        "run_attempt": { "type": "string" },
        "sha": { "type": "string" },
        "ref": { "type": "string" },
        "runner_name": { "type": "string" },
        "url": { "$ref": "#/definitions/nstr" }
      }
    },
    "runner": {
      "type": "object",
      "additionalProperties": false,
      "required": ["cpus", "mem_total", "os", "arch", "kernel"],
      "properties": {
        "cpus": { "$ref": "#/definitions/nnum" },
        "mem_total": { "$ref": "#/definitions/nnum" },
        "os": { "type": "string" },
        "arch": { "$ref": "#/definitions/nstr" },
        "kernel": { "$ref": "#/definitions/nstr" }
      }
    },
    "capabilities": {
      "type": "object",
      "additionalProperties": false,
      "required": ["psi", "docker_cgroups", "docker_socket", "steps_api", "dmesg"],
      "properties": {
        "psi": { "type": "boolean" },
        "docker_cgroups": { "type": "boolean" },
        "docker_socket": { "type": "boolean" },
        "steps_api": { "type": "boolean" },
        "dmesg": { "type": "boolean" }
      }
    },
    "steps": { "oneOf": [{ "type": "null" }, { "type": "array", "items": { "$ref": "#/definitions/step" } }] },
    "steps_error": { "type": "string" },
    "totals": {
      "type": "object",
      "additionalProperties": false,
      "required": ["duration_s", "samples", "cpu_avg", "cpu_max", "mem_peak", "steal_avg", "psi_max", "min_root_free", "min_ws_free", "swap_start", "swap_max"],
      "properties": {
        "duration_s": { "type": "number" },
        "samples": { "type": "integer" },
        "cpu_avg": { "$ref": "#/definitions/nnum" },
        "cpu_max": { "$ref": "#/definitions/nnum" },
        "mem_peak": { "$ref": "#/definitions/nnum" },
        "steal_avg": { "$ref": "#/definitions/nnum" },
        "psi_max": { "$ref": "#/definitions/psiMax" },
        "min_root_free": { "$ref": "#/definitions/nnum" },
        "min_ws_free": { "$ref": "#/definitions/nnum" },
        "swap_start": { "$ref": "#/definitions/nnum" },
        "swap_max": { "$ref": "#/definitions/nnum" }
      }
    },
    "containers": { "type": "array", "items": { "$ref": "#/definitions/container" } },
    "oom_events": { "type": "array", "items": { "$ref": "#/definitions/oom" } },
    "findings": { "type": "array", "items": { "$ref": "#/definitions/finding" } },
    "collector": {
      "type": "object",
      "additionalProperties": false,
      "required": ["peak_rss", "cpu_seconds", "avg_cpu_pct", "end_reason", "invalid_lines"],
      "properties": {
        "peak_rss": { "$ref": "#/definitions/nnum" },
        "cpu_seconds": { "$ref": "#/definitions/nnum" },
        "avg_cpu_pct": { "$ref": "#/definitions/nnum" },
        "end_reason": { "enum": ["sigterm", "watch-pid-gone", "max-duration", "missing", "not-started"] },
        "invalid_lines": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`test/report.test.ts`:
```ts
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import schema from '../schema/report.schema.json';
import { buildReport } from '../src/report';
import { makeEnd, makeReport, makeSample, parsed, T0 } from './fixtures';

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe('buildReport', () => {
  it('produces a schema-valid report with steps, containers and collector overhead', () => {
    const { report } = makeReport();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.job).toMatchObject({ repository: 'o/r', job: 'build', job_name: 'build' });
    expect(report.runner).toMatchObject({ cpus: 2, mem_total: 8_000_000_000, os: 'Linux', arch: 'x86_64' });
    expect(report.steps?.map((s) => s.name)).toEqual(['Set up job', 'Build | test', 'Post ci-telemetry']);
    expect(report.containers[0]).toMatchObject({ name: 'db', image: 'postgres:16' });
    expect(report.collector).toEqual({ peak_rss: 1_800_000, cpu_seconds: 0.03, avg_cpu_pct: 0.5, end_reason: 'sigterm', invalid_lines: 0 });
    expect(report.capabilities).toEqual({ psi: true, docker_cgroups: true, docker_socket: true, steps_api: true, dmesg: false });
  });

  it('stays schema-valid with no steps, no meta and a dead collector', () => {
    const r = buildReport({
      parsed: parsed({ meta: null, samples: [makeSample(T0 + 1)] }),
      steps: { steps: null, error: 'GitHub API returned 403' },
      dmesg: `${new Date((T0 + 1) * 1000).toISOString().replace('.000Z', ',0+00:00')} Out of memory: Killed process 9 (cc1plus)`,
      stopResult: 'not-running',
      env: {},
      now: T0 + 10,
    });
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
    expect(r.steps).toBeNull();
    expect(r.steps_error).toBe('GitHub API returned 403');
    expect(r.collector.end_reason).toBe('missing');
    expect(r.oom_events.map((e) => e.source)).toEqual(['kernel', 'collector']);
    expect(r.findings.filter((f) => f.code === 'oom')).toHaveLength(2);
  });

  it('assigns OOM events to steps', () => {
    const r = buildReport({
      parsed: parsed({ samples: [makeSample(T0 + 1)], end: makeEnd(T0 + 2) }),
      steps: { steps: [{ name: 'Build', number: 1, conclusion: 'failure', started_at: T0, completed_at: T0 + 5 }] },
      dmesg: `${new Date((T0 + 1) * 1000).toISOString().replace('.000Z', ',0+00:00')} Out of memory: Killed process 9 (cc1plus)`,
      stopResult: 'stopped', env: {}, now: T0 + 10,
    });
    expect(r.oom_events[0].step).toBe('Build');
  });

  it('rejects a report missing a required key', () => {
    const { report } = makeReport();
    const { steps: _omit, ...broken } = report;
    expect(validate(broken)).toBe(false);
  });
});
```

Append to `test/fixtures.ts`:
```ts
import { buildReport, Report } from '../src/report';

export function makeReport(): { report: Report; samples: Sample[] } {
  const ctrId = 'c'.repeat(64);
  const samples = [0, 1, 2, 3, 4].map((i) =>
    makeSample(T0 + 1 + i, {
      cpu: { usr: 50, sys: 10, iow: 1, steal: 0 },
      disk: { rd: 1024 * i, wr: 2048 },
      net: { rx: 4096, tx: 512 },
      ctr: [{ id: ctrId, cpu: 20, mem: 100_000_000 + i, mem_peak: 120_000_000, io_rd: 0, io_wr: 0, oom_kills: 0 }],
    }),
  );
  const p = parsed({ samples, containers: new Map([[ctrId, { name: 'db', image: 'postgres:16' }]]), end: makeEnd(T0 + 6) });
  const report = buildReport({
    parsed: p,
    steps: {
      steps: [
        { name: 'Set up job', number: 1, conclusion: 'success', started_at: T0 - 10, completed_at: T0 - 5 },
        { name: 'Build | test', number: 2, conclusion: 'success', started_at: T0, completed_at: T0 + 3 },
        { name: 'Post ci-telemetry', number: 3, conclusion: null, started_at: T0 + 3, completed_at: null },
      ],
      jobName: 'build',
      jobUrl: 'https://github.com/o/r/actions/runs/1/job/2',
    },
    dmesg: null,
    stopResult: 'stopped',
    env: {
      GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'build', GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'abc123', GITHUB_REF: 'refs/heads/main', RUNNER_NAME: 'GitHub Actions 1',
    },
    now: T0 + 6,
  });
  return { report, samples };
}
```
(Move the new `import` line to the top of the file with the other imports.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL, `../src/report` can't be resolved.

- [ ] **Step 4: Implement**

`src/report.ts`:
```ts
import { aggregateContainers, aggregateSteps, ContainerStats, JobTotals, jobTotals, StepStats, stepAt } from './aggregate';
import type { StopResult } from './collector-control';
import { computeFindings, Finding } from './findings';
import { iso, round2 } from './format';
import { collectorOomEvent, containerOomEvents, OomEvent, parseDmesg } from './oom';
import type { StepsResult } from './steps';
import { ParsedSamples } from './types';

export interface Report {
  schema_version: 1;
  generated_at: string;
  job: {
    repository: string; workflow: string; job: string; job_name: string | null; run_id: string;
    run_attempt: string; sha: string; ref: string; runner_name: string; url: string | null;
  };
  runner: { cpus: number | null; mem_total: number | null; os: string; arch: string | null; kernel: string | null };
  capabilities: { psi: boolean; docker_cgroups: boolean; docker_socket: boolean; steps_api: boolean; dmesg: boolean };
  steps: StepStats[] | null;
  steps_error?: string;
  totals: JobTotals;
  containers: ContainerStats[];
  oom_events: OomEvent[];
  findings: Finding[];
  collector: {
    peak_rss: number | null;
    cpu_seconds: number | null;
    avg_cpu_pct: number | null;
    end_reason: 'sigterm' | 'watch-pid-gone' | 'max-duration' | 'missing' | 'not-started';
    invalid_lines: number;
  };
}

export interface BuildReportInput {
  parsed: ParsedSamples;
  steps: StepsResult;
  dmesg: string | null;
  stopResult: StopResult | 'not-started';
  env: Record<string, string | undefined>;
  now: number;
}

export function buildReport(i: BuildReportInput): Report {
  const p = i.parsed;
  const steps = i.steps.steps;
  const from = p.meta?.t ?? p.samples[0]?.t ?? i.now;
  const oom = [
    ...(i.dmesg !== null ? parseDmesg(i.dmesg, from, i.now) : []),
    ...containerOomEvents(p.samples, p.containers),
    ...collectorOomEvent(p, i.stopResult),
  ]
    .map((e) => ({ ...e, step: steps ? stepAt(e.t, steps)?.name ?? null : null }))
    .sort((a, b) => a.t - b.t);

  const stepStats = steps ? aggregateSteps(p, steps) : null;
  const totals = jobTotals(p);
  const endReason = (p.end?.reason ?? (i.stopResult === 'not-started' ? 'not-started' : 'missing')) as Report['collector']['end_reason'];
  const wall = p.end && p.meta ? p.end.t - p.meta.t : 0;
  const e = i.env;

  const report: Report = {
    schema_version: 1,
    generated_at: iso(i.now),
    job: {
      repository: e.GITHUB_REPOSITORY ?? '',
      workflow: e.GITHUB_WORKFLOW ?? '',
      job: e.GITHUB_JOB ?? '',
      job_name: i.steps.jobName ?? null,
      run_id: e.GITHUB_RUN_ID ?? '',
      run_attempt: e.GITHUB_RUN_ATTEMPT ?? '',
      sha: e.GITHUB_SHA ?? '',
      ref: e.GITHUB_REF ?? '',
      runner_name: e.RUNNER_NAME ?? '',
      url: i.steps.jobUrl ?? null,
    },
    runner: {
      cpus: p.meta?.cpus ?? null,
      mem_total: p.meta?.mem_total ?? null,
      os: 'Linux',
      arch: p.meta?.arch ?? null,
      kernel: p.meta?.kernel ?? null,
    },
    capabilities: {
      psi: p.meta?.capabilities.psi ?? false,
      docker_cgroups: p.meta?.capabilities.docker_cgroups ?? false,
      docker_socket: p.meta?.capabilities.docker_socket ?? false,
      steps_api: steps !== null,
      dmesg: i.dmesg !== null,
    },
    steps: stepStats,
    totals,
    containers: aggregateContainers(p),
    oom_events: oom,
    findings: computeFindings({ steps: stepStats, totals, oom }),
    collector: {
      peak_rss: p.end?.self.peak_rss ?? null,
      cpu_seconds: p.end?.self.cpu_seconds ?? null,
      avg_cpu_pct: p.end && wall > 0 ? round2((p.end.self.cpu_seconds / wall) * 100) : null,
      end_reason: endReason,
      invalid_lines: p.invalidLines,
    },
  };
  if (i.steps.error) report.steps_error = i.steps.error;
  return report;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/report.ts schema/report.schema.json test/fixtures.ts test/report.test.ts
git commit -m "feat(action): assemble report.json with a JSON Schema"
```

---

### Task 15: Job summary (Markdown)

**Files:**
- Create: `src/render/summary.ts`
- Test: `test/summary.test.ts`

**Interfaces:**
- Consumes: `Report`, `format.*`
- Produces: `renderSummary(r: Report): string`

The emoji status markers (🔴 / ⚠️) stay in the **job summary only**. The spec approved them, and GitHub's summary view has no other way to show a status icon. The HTML report (Task 16) follows the taste skill's no-emoji rule.

- [ ] **Step 1: Write the failing tests**

`test/summary.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderSummary } from '../src/render/summary';
import { makeReport } from './fixtures';

describe('renderSummary', () => {
  const { report } = makeReport();
  const md = renderSummary(report);

  it('has a header line with runner size and collector overhead', () => {
    expect(md).toContain('## CI telemetry');
    expect(md).toContain('**Runner:** 2 vCPU / 7.5 GiB');
    expect(md).toContain('collector overhead 1.7 MiB RSS, 0.5% CPU');
  });

  it('renders one row per step with pipes escaped', () => {
    expect(md).toContain('| # | Step | Duration | CPU avg | CPU max | Peak memory | Max mem pressure | Max I/O pressure |');
    expect(md).toContain('| 2 | Build \\| test | 3s | 60.0% | 60.0% | 953.7 MiB | 0.0% | 0.0% |');
    expect(md).toContain('| 1 | Set up job | 5s | – | – | – | – | – |');
  });

  it('renders containers', () => {
    expect(md).toContain('| db | postgres:16 | 20.0% | 20.0% | 114.4 MiB | 0 |');
  });

  it('explains a missing step breakdown and lists findings', () => {
    const noSteps = { ...report, steps: null, steps_error: 'GitHub API returned 403', findings: [{ level: 'error' as const, code: 'oom', message: 'OOM kill of node (pid 1)', step: null }] };
    const out = renderSummary(noSteps);
    expect(out).toContain('_Per-step breakdown unavailable: GitHub API returned 403_');
    expect(out).toContain('- 🔴 OOM kill of node (pid 1)');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/summary.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/render/summary.ts`:
```ts
import { formatBytes, formatDuration, pct } from '../format';
import { Report } from '../report';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\r?\n/g, ' ');
const bytes = (n: number | null) => (n === null ? '–' : formatBytes(n));

export function renderSummary(r: Report): string {
  const out: string[] = ['## CI telemetry', ''];
  const size = r.runner.cpus !== null && r.runner.mem_total !== null
    ? `${r.runner.cpus} vCPU / ${formatBytes(r.runner.mem_total)}`
    : 'unknown size';
  const overhead = r.collector.peak_rss !== null
    ? `collector overhead ${formatBytes(r.collector.peak_rss)} RSS, ${pct(r.collector.avg_cpu_pct)} CPU`
    : 'collector overhead unknown';
  out.push(`**Runner:** ${size} · **Sampled:** ${formatDuration(r.totals.duration_s)} · ${overhead}`, '');

  if (r.findings.length) {
    out.push('### Findings', '');
    for (const f of r.findings) out.push(`- ${f.level === 'error' ? '🔴' : '⚠️'} ${esc(f.message)}`);
    out.push('');
  }

  if (r.steps) {
    out.push('### Steps', '',
      '| # | Step | Duration | CPU avg | CPU max | Peak memory | Max mem pressure | Max I/O pressure |',
      '|---:|---|---:|---:|---:|---:|---:|---:|');
    for (const s of r.steps) {
      out.push(`| ${s.number} | ${esc(s.name)} | ${formatDuration(s.duration_s)} | ${pct(s.cpu_avg)} | ${pct(s.cpu_max)} | ${bytes(s.mem_peak)} | ${pct(s.psi_max?.mem_full ?? null)} | ${pct(s.psi_max?.io_full ?? null)} |`);
    }
    out.push('');
  } else {
    out.push(`_Per-step breakdown unavailable: ${esc(r.steps_error ?? 'unknown reason')}_`, '');
  }

  if (r.containers.length) {
    out.push('### Containers', '', '| Container | Image | CPU avg | CPU max | Peak memory | OOM kills |', '|---|---|---:|---:|---:|---:|');
    for (const c of r.containers) {
      out.push(`| ${esc(c.name)} | ${esc(c.image ?? '–')} | ${pct(c.cpu_avg)} | ${pct(c.cpu_max)} | ${formatBytes(c.mem_peak)} | ${c.oom_kills} |`);
    }
    out.push('');
  }

  out.push('_Download the ci-telemetry artifact for the full HTML report and raw samples._');
  return out.join('\n') + '\n';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/summary.test.ts && npx tsc --noEmit`
Expected: PASS. If a formatted number differs, recompute it from `makeReport()` data; never loosen the assertion to `toContain('Build')`.

- [ ] **Step 5: Commit**

```bash
git add src/render/summary.ts test/summary.test.ts
git commit -m "feat(action): render the job summary"
```

---

### Task 16: HTML report (following the taste skill's `minimalist-ui` style)

**Files:**
- Create: `src/render/html.ts`
- Test: `test/html.test.ts`

**Interfaces:**
- Consumes: `Report`, `Sample`, `format.*`
- Produces: `escapeHtml(s): string`, `minMaxBucket(points: [number, number][], maxPoints?): [number, number][]`, `renderHtml(r: Report, samples: Sample[]): string`

**Design direction.** The user asked for the taste skill. Read `.claude/skills/minimalist-ui/SKILL.md` before starting. It is installed in the repo via `npx skills add Leonxlnx/taste-skill`, and the rules below are its application to an **offline, single-file data report**:
- Warm monochrome canvas: `#FBFBFA` background, `#FFFFFF` cards, `1px solid #EAEAEA` borders, 12px radius, generous padding (20–24px). No gradients, no heavy shadows, no pill-shaped containers.
- Type: an editorial serif for the title, section headings and big numbers (`"Lyon Text","Newsreader","Iowan Old Style","Charter",Georgia,serif`, tracking −0.02 to −0.03em, line-height 1.1). A system sans for body text (`"SF Pro Display",-apple-system,…,"Helvetica Neue",sans-serif`; never Inter or Roboto). Mono for metadata, numbers in tables and axis labels. Body text is off-black `#2F3437` at line-height 1.6, and secondary text is `#787774`.
- Colour is used only where it means something. Chart series use the skill's muted text tones (charcoal `#2F3437`, blue `#1F6C9F`, green `#346538`, amber `#956400`, red `#9F2F2D`, plum `#6E5A8A`). Finding tags are small uppercase pills on the pale pastels: red `#FDEBEC`/`#9F2F2D` for errors, yellow `#FBF3DB`/`#956400` for warnings, green `#EDF3EC`/`#346538` for OK.
- **No emojis anywhere in the HTML.** Status is shown with text pills.
- Layout: max width 1040px, 72px between sections. The top-level figures sit in an asymmetric 6-column grid of cards (spans 2-2-2-3-3). Tables have no boxes around them, only a 1px bottom border on each row.
- Motion: CSS-only fade-up (`translateY(12px)` over 600ms, `cubic-bezier(0.16,1,0.3,1)`, staggered 80ms using `--i`), turned off under `prefers-reduced-motion` and in print. No JavaScript at all.
- **Adapted to the report's constraints:** the skill's photo, Google Fonts and icon-library suggestions are skipped, because the report must work offline (no external URLs of any kind), so only system font stacks are used. A warm dark theme is added under `prefers-color-scheme: dark`, and every colour is a CSS custom property so the charts follow the theme.

- [ ] **Step 1: Write the failing tests**

`test/html.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, minMaxBucket, renderHtml } from '../src/render/html';
import { makeReport } from './fixtures';

describe('minMaxBucket', () => {
  it('returns short series unchanged', () => {
    const pts: [number, number][] = [[1, 1], [2, 2]];
    expect(minMaxBucket(pts, 10)).toBe(pts);
  });
  it('bounds long series and keeps spikes, in time order', () => {
    const pts: [number, number][] = Array.from({ length: 10_000 }, (_, i) => [i, i % 100]);
    pts[5000] = [5000, 1e6];
    const out = minMaxBucket(pts, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.some((p) => p[1] === 1e6)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThanOrEqual(out[i - 1][0]);
  });
});

describe('renderHtml', () => {
  const { report, samples } = makeReport();
  const html = renderHtml(report, samples);

  it('is a complete, self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script|<link|@import|url\(/i);
  });

  it('draws five charts, plus container memory when containers exist', () => {
    expect(html.match(/<svg /g)).toHaveLength(6);
    const noCtr = renderHtml({ ...report, containers: [] }, samples);
    expect(noCtr.match(/<svg /g)).toHaveLength(5);
  });

  it('follows the minimalist-ui rules: tokens, dark mode, reduced motion, no emoji', () => {
    expect(html).toContain('--bg:#FBFBFA');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('prefers-reduced-motion:reduce');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toMatch(/\bInter\b|Roboto/);
  });

  it('shows step bands, tables and an OK pill when there are no findings', () => {
    expect(html).toContain('<title>Build | test</title>');
    expect(html).toContain('Build | test');
    expect(html).toContain('postgres:16');
    expect(html).toContain('class="tag tag-ok"');
  });

  it('renders findings as pills and marks OOM events', () => {
    const withOom = {
      ...report,
      oom_events: [{ t: samples[2].t, process: 'node', pid: 7, source: 'kernel' as const, step: 'Build | test' }],
      findings: [{ level: 'error' as const, code: 'oom', message: 'OOM kill of node (pid 7)', step: null }],
    };
    const out = renderHtml(withOom, samples);
    expect(out).toContain('class="tag tag-error"');
    expect(out).toContain('class="oom"');
  });

  it('escapes user-controlled text', () => {
    const evil = { ...report, steps: report.steps!.map((s) => ({ ...s, name: '<img src=x onerror=alert(1)>' })) };
    const out = renderHtml(evil, samples);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml(`a&"'`)).toBe('a&amp;&quot;&#39;');
  });

  it('renders without samples or steps', () => {
    const out = renderHtml({ ...report, steps: null, steps_error: 'no github-token available', containers: [] }, []);
    expect(out).toContain('Per-step breakdown unavailable: no github-token available');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/html.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/render/html.ts`:
```ts
import { formatBytes, formatDuration, pct } from '../format';
import { Report } from '../report';
import { Sample } from '../types';

type Point = [number, number];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`);

/** Reduce to about maxPoints by keeping each bucket's min and max, so short spikes survive. */
export function minMaxBucket(points: Point[], maxPoints = 2000): Point[] {
  if (points.length <= maxPoints) return points;
  const buckets = Math.floor(maxPoints / 2);
  const size = points.length / buckets;
  const out: Point[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = points.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!slice.length) continue;
    let lo = slice[0];
    let hi = slice[0];
    for (const p of slice) {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
  }
  return out;
}

interface Series { label: string; tone: number; points: Point[]; area?: boolean }
interface Band { start: number; end: number; label: string }
interface ChartOpts {
  title: string;
  series: Series[];
  bands: Band[];
  markers: number[];
  t0: number;
  t1: number;
  yMax?: number;
  yFormat: (v: number) => string;
}

const W = 960;
const H = 220;
const L = 64;
const R = 16;
const TOP = 28;
const BOTTOM = 28;
const f1 = (n: number) => n.toFixed(1);

function chart(o: ChartOpts, i: number): string {
  const span = Math.max(1e-9, o.t1 - o.t0);
  const series = o.series.map((s) => ({ ...s, points: minMaxBucket(s.points) }));
  let peak = 0;
  for (const s of series) for (const p of s.points) if (p[1] > peak) peak = p[1];
  const yMax = o.yMax ?? (peak > 0 ? peak * 1.1 : 1);
  const x = (t: number) => L + ((t - o.t0) / span) * (W - L - R);
  const y = (v: number) => TOP + (1 - Math.min(Math.max(v, 0), yMax) / yMax) * (H - TOP - BOTTOM);
  const parts: string[] = [];

  o.bands.forEach((b, bi) => {
    const x0 = x(Math.max(b.start, o.t0));
    const x1 = x(Math.min(b.end, o.t1));
    if (x1 - x0 < 1) return;
    parts.push(`<rect class="band${bi % 2}" x="${f1(x0)}" y="${TOP}" width="${f1(x1 - x0)}" height="${H - TOP - BOTTOM}"><title>${escapeHtml(b.label)}</title></rect>`);
    const room = Math.floor((x1 - x0 - 8) / 6);
    if (room >= 4) parts.push(`<text class="blabel" x="${f1(x0 + 4)}" y="${TOP - 8}">${escapeHtml(truncate(b.label, room))}</text>`);
  });
  for (const g of [0, 0.5, 1]) {
    const yy = f1(y(yMax * g));
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="ylabel" x="${L - 8}" y="${yy}" dy="3">${escapeHtml(o.yFormat(yMax * g))}</text>`);
  }
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    const anchor = g === 0 ? 'start' : g === 1 ? 'end' : 'middle';
    parts.push(`<text class="xlabel" text-anchor="${anchor}" x="${f1(L + g * (W - L - R))}" y="${H - 8}">${formatDuration(g * span)}</text>`);
  }
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, pi) => `${pi ? 'L' : 'M'}${f1(x(p[0]))} ${f1(y(p[1]))}`).join('');
    if (s.area) {
      const last = s.points[s.points.length - 1][0];
      parts.push(`<path class="ar t${s.tone}" d="${d}L${f1(x(last))} ${f1(y(0))}L${f1(x(s.points[0][0]))} ${f1(y(0))}Z"/>`);
    }
    parts.push(`<path class="ln t${s.tone}" d="${d}"/>`);
  }
  for (const m of o.markers) {
    if (m < o.t0 || m > o.t1) continue;
    const xx = f1(x(m));
    parts.push(`<line class="oom" x1="${xx}" x2="${xx}" y1="${TOP}" y2="${H - BOTTOM}"/>`);
  }
  const legend = o.series.map((s) => `<span class="key t${s.tone}"><i></i>${escapeHtml(s.label)}</span>`).join('');
  return `<figure class="card chart reveal" style="--i:${i}"><figcaption><span class="ctitle">${escapeHtml(o.title)}</span><span class="legend">${legend}</span></figcaption>`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(o.title)}">${parts.join('')}</svg></figure>`;
}

function containerStack(samples: Sample[], r: Report): Series[] {
  const ids = r.containers.map((c) => c.id);
  const cum: Point[][] = ids.map(() => []);
  for (const s of samples) {
    if (!s.ctr) continue;
    let acc = 0;
    ids.forEach((id, i) => {
      acc += s.ctr!.find((c) => c.id === id)?.mem ?? 0;
      cum[i].push([s.t, acc]);
    });
  }
  // Largest cumulative series first so smaller areas paint on top of it.
  return ids.map((_, i) => ({ label: r.containers[i].name, tone: i % 6, points: cum[i], area: true })).reverse();
}

function table(cols: Array<{ h: string; num?: boolean }>, rows: string[][]): string {
  const th = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${escapeHtml(c.h)}</th>`).join('');
  const tr = rows.map((row) => `<tr>${row.map((cell, i) => `<td${cols[i].num ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

const bytes = (n: number | null) => (n === null ? '–' : formatBytes(n));

function stat(label: string, value: string, note: string, width: 2 | 3, i: number): string {
  return `<div class="card stat w${width} reveal" style="--i:${i}"><div class="label">${escapeHtml(label)}</div>`
    + `<div class="value">${escapeHtml(value)}</div><div class="note">${escapeHtml(note)}</div></div>`;
}

export function renderHtml(r: Report, samples: Sample[]): string {
  const t0 = samples.length ? samples[0].t : 0;
  const t1 = samples.length > 1 ? samples[samples.length - 1].t : t0 + 1;
  const bands: Band[] = (r.steps ?? [])
    .filter((s) => s.samples > 0)
    .map((s) => ({ start: Date.parse(s.started_at) / 1000, end: s.completed_at ? Date.parse(s.completed_at) / 1000 : t1, label: s.name }));
  const markers = r.oom_events.map((e) => e.t);
  const pts = (f: (s: Sample) => number | null | undefined): Point[] =>
    samples.flatMap((s) => {
      const v = f(s);
      return typeof v === 'number' ? [[s.t, v] as Point] : [];
    });
  const base = { bands, markers, t0, t1 };
  const percent = (v: number) => `${Math.round(v)}%`;
  const perSec = (v: number) => `${formatBytes(v)}/s`;

  const charts = [
    chart({ ...base, title: 'CPU, % of all cores', yMax: 100, yFormat: percent, series: [
      { label: 'user', tone: 0, points: pts((s) => s.cpu.usr), area: true },
      { label: 'system', tone: 1, points: pts((s) => s.cpu.sys) },
      { label: 'iowait', tone: 3, points: pts((s) => s.cpu.iow) },
      { label: 'steal', tone: 4, points: pts((s) => s.cpu.steal) },
    ] }, 0),
    chart({ ...base, title: 'Memory', yMax: r.runner.mem_total ?? undefined, yFormat: formatBytes, series: [
      { label: 'used', tone: 0, points: pts((s) => s.mem.used), area: true },
      { label: 'page cache', tone: 1, points: pts((s) => s.mem.cached) },
      { label: 'swap', tone: 4, points: pts((s) => s.mem.swap) },
    ] }, 1),
    chart({ ...base, title: 'Pressure stall, 10 s average', yMax: 100, yFormat: percent, series: [
      { label: 'cpu some', tone: 1, points: pts((s) => s.psi?.cpu_some) },
      { label: 'memory full', tone: 4, points: pts((s) => s.psi?.mem_full) },
      { label: 'io full', tone: 3, points: pts((s) => s.psi?.io_full) },
    ] }, 2),
    chart({ ...base, title: 'Disk throughput', yFormat: perSec, series: [
      { label: 'read', tone: 1, points: pts((s) => s.disk.rd) },
      { label: 'write', tone: 2, points: pts((s) => s.disk.wr) },
    ] }, 3),
    chart({ ...base, title: 'Network throughput', yFormat: perSec, series: [
      { label: 'in', tone: 1, points: pts((s) => s.net.rx) },
      { label: 'out', tone: 2, points: pts((s) => s.net.tx) },
    ] }, 4),
  ];
  if (r.containers.length) {
    charts.push(chart({ ...base, title: 'Container memory, stacked', yFormat: formatBytes, series: containerStack(samples, r) }, 5));
  }

  const t = r.totals;
  const memNote = t.mem_peak !== null && r.runner.mem_total
    ? `${Math.round((t.mem_peak / r.runner.mem_total) * 100)}% of ${formatBytes(r.runner.mem_total)}`
    : 'runner total unknown';
  const stats = [
    stat('Sampled', formatDuration(t.duration_s), `${t.samples} samples`, 2, 0),
    stat('Peak memory', bytes(t.mem_peak), memNote, 2, 1),
    stat('Memory pressure', pct(t.psi_max?.mem_full ?? null), 'peak PSI full, 10 s average', 2, 2),
    stat('CPU average', pct(t.cpu_avg), `peak ${pct(t.cpu_max)} across ${r.runner.cpus ?? '?'} vCPU`, 3, 3),
    stat('Collector overhead', bytes(r.collector.peak_rss), `${pct(r.collector.avg_cpu_pct)} of one core`, 3, 4),
  ].join('');

  const findings = r.findings.length
    ? r.findings.map((f) => `<li><span class="tag tag-${f.level}">${f.level === 'error' ? 'Error' : 'Warning'}</span><span>${escapeHtml(f.message)}</span></li>`).join('')
    : '<li><span class="tag tag-ok">OK</span><span>No bottlenecks detected.</span></li>';

  const steps = r.steps
    ? table(
        [{ h: '#', num: true }, { h: 'Step' }, { h: 'Duration', num: true }, { h: 'CPU avg', num: true }, { h: 'CPU max', num: true },
          { h: 'Peak mem', num: true }, { h: 'Mem pressure', num: true }, { h: 'I/O pressure', num: true },
          { h: 'Disk read', num: true }, { h: 'Disk write', num: true }, { h: 'Net in', num: true }, { h: 'Net out', num: true }],
        r.steps.map((s) => [
          String(s.number),
          `${escapeHtml(s.name)}${s.conclusion === 'failure' ? '<span class="tag tag-error">Failed</span>' : ''}`,
          formatDuration(s.duration_s), pct(s.cpu_avg), pct(s.cpu_max), bytes(s.mem_peak),
          pct(s.psi_max?.mem_full ?? null), pct(s.psi_max?.io_full ?? null),
          bytes(s.disk_rd), bytes(s.disk_wr), bytes(s.net_rx), bytes(s.net_tx),
        ]),
      )
    : `<p class="lede">Per-step breakdown unavailable: ${escapeHtml(r.steps_error ?? 'unknown reason')}</p>`;

  const containers = r.containers.length
    ? `<section class="reveal" style="--i:3"><h2>Containers</h2>${table(
        [{ h: 'Name' }, { h: 'Image' }, { h: 'CPU avg', num: true }, { h: 'CPU max', num: true }, { h: 'Peak mem', num: true }, { h: 'OOM kills', num: true }],
        r.containers.map((c) => [escapeHtml(c.name), escapeHtml(c.image ?? '–'), pct(c.cpu_avg), pct(c.cpu_max), formatBytes(c.mem_peak), String(c.oom_kills)]),
      )}</section>`
    : '';

  const ooms = r.oom_events.length
    ? `<section class="reveal" style="--i:4"><h2>OOM events</h2>${table(
        [{ h: 'Time (UTC)' }, { h: 'Process' }, { h: 'Source' }, { h: 'Step' }],
        r.oom_events.map((e) => [new Date(e.t * 1000).toISOString().slice(11, 19), escapeHtml(e.pid === null ? e.process : `${e.process} (${e.pid})`), e.source, escapeHtml(e.step ?? '–')]),
      )}</section>`
    : '';

  const title = (r.job.job_name ?? r.job.job) || 'CI job';
  const eyebrow = [r.job.repository, r.job.workflow, r.job.run_id && `run ${r.job.run_id}/${r.job.run_attempt}`, r.job.sha.slice(0, 7)]
    .filter(Boolean).join(' · ');
  const size = r.runner.cpus !== null && r.runner.mem_total !== null ? `${r.runner.cpus} vCPU / ${formatBytes(r.runner.mem_total)}` : 'unknown runner size';
  const lede = `${r.steps?.length ?? 0} steps · ${formatDuration(t.duration_s)} sampled · ${size}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)} · CI telemetry</title><style>${CSS}</style></head><body><main class="wrap">`
    + `<header class="reveal"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(lede)}</p></header>`
    + `<div class="stats">${stats}</div>`
    + `<section class="reveal" style="--i:1"><h2>Findings</h2><ul class="findings">${findings}</ul></section>`
    + `<section><h2 class="reveal">Timeline</h2><div class="charts">${charts.join('')}</div></section>`
    + `<section class="reveal" style="--i:2"><h2>Steps</h2>${steps}</section>`
    + containers + ooms
    + `<footer>Generated ${escapeHtml(r.generated_at)} by ci-telemetry · report schema v${r.schema_version}</footer>`
    + `</main></body></html>`;
}

const CSS = [
  ':root{--bg:#FBFBFA;--surface:#FFFFFF;--band:#F4F3EF;--border:#EAEAEA;--text:#2F3437;--muted:#787774;--strong:#111111;',
  '--c1:#2F3437;--c2:#1F6C9F;--c3:#346538;--c4:#956400;--c5:#9F2F2D;--c6:#6E5A8A;',
  '--red-bg:#FDEBEC;--red:#9F2F2D;--yellow-bg:#FBF3DB;--yellow:#956400;--green-bg:#EDF3EC;--green:#346538;',
  '--sans:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Geist Sans","Helvetica Neue","Switzer",sans-serif;',
  '--serif:"Lyon Text","Newsreader","Iowan Old Style","Charter",Georgia,serif;',
  '--mono:"Geist Mono","SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace;color-scheme:light dark}',
  '@media (prefers-color-scheme:dark){:root{--bg:#191918;--surface:#1F1F1E;--band:#252523;--border:#2F2F2D;--text:#E3E2DE;--muted:#9B9A97;--strong:#F4F3EF;',
  '--c1:#D4D3CF;--c2:#6FB1DB;--c3:#86B98A;--c4:#D9A941;--c5:#E0787A;--c6:#B09CD0;',
  '--red-bg:#3A2324;--red:#E0787A;--yellow-bg:#352D1A;--yellow:#D9A941;--green-bg:#1F2E21;--green:#86B98A}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}',
  '.wrap{max-width:1040px;margin:0 auto;padding:72px 24px 96px}',
  '.eyebrow{font:12px/1.4 var(--mono);color:var(--muted);letter-spacing:.02em;margin:0 0 16px}',
  'h1{font:400 44px/1.1 var(--serif);letter-spacing:-.03em;color:var(--strong);margin:0 0 12px}',
  'h2{font:400 24px/1.2 var(--serif);letter-spacing:-.02em;color:var(--strong);margin:0 0 20px}',
  '.lede{color:var(--muted);margin:0}',
  'section{margin-top:72px}',
  '.card{background:var(--surface);border:1px solid var(--border);border-radius:12px}',
  '.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;margin-top:48px}',
  '.stat{padding:24px}.w2{grid-column:span 2}.w3{grid-column:span 3}',
  '.label,th{font:600 11px/1.4 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}',
  '.value{font:400 34px/1.15 var(--serif);letter-spacing:-.03em;color:var(--strong);margin:10px 0 6px;font-variant-numeric:tabular-nums}',
  '.note{font-size:13px;color:var(--muted)}',
  '.findings{list-style:none;margin:0;padding:0}',
  '.findings li{display:flex;gap:14px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--border)}',
  '.tag{flex:none;border-radius:9999px;padding:2px 10px;font:600 10.5px/1.6 var(--sans);text-transform:uppercase;letter-spacing:.06em}',
  '.tag-error{background:var(--red-bg);color:var(--red)}.tag-warning{background:var(--yellow-bg);color:var(--yellow)}.tag-ok{background:var(--green-bg);color:var(--green)}',
  '.charts{display:grid;gap:16px}',
  '.chart{margin:0;padding:20px 20px 12px}',
  'figcaption{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 20px;margin-bottom:8px}',
  '.ctitle{font-weight:600;font-size:14px;color:var(--strong)}',
  '.legend{display:flex;flex-wrap:wrap;gap:14px;font:12px var(--mono);color:var(--muted)}',
  '.key i{display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c);margin-right:6px}',
  'svg{display:block;width:100%;height:auto;overflow:visible}',
  '.t0{--c:var(--c1)}.t1{--c:var(--c2)}.t2{--c:var(--c3)}.t3{--c:var(--c4)}.t4{--c:var(--c5)}.t5{--c:var(--c6)}',
  '.ln{fill:none;stroke:var(--c);stroke-width:1.5;stroke-linejoin:round}',
  '.ar{fill:var(--c);fill-opacity:.12;stroke:none}',
  '.band0{fill:var(--band)}.band1{fill:transparent}',
  '.blabel,.ylabel,.xlabel{font:10px var(--mono);fill:var(--muted)}.ylabel{text-anchor:end}',
  '.grid{stroke:var(--border);stroke-width:1}',
  '.oom{stroke:var(--red);stroke-width:1.5;stroke-dasharray:3 3}',
  '.table-wrap{overflow-x:auto}',
  'table{width:100%;border-collapse:collapse;font-size:13.5px}',
  'th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);white-space:nowrap}',
  'td{padding:12px;border-bottom:1px solid var(--border);vertical-align:baseline}',
  '.num{text-align:right;font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
  'td .tag{margin-left:8px}',
  'footer{margin-top:72px;font:12px var(--mono);color:var(--muted)}',
  '.reveal{animation:rise .6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i,0)*80ms)}',
  '@keyframes rise{from{opacity:0;transform:translateY(12px)}}',
  '@media (prefers-reduced-motion:reduce){.reveal{animation:none}}',
  '@media print{.reveal{animation:none}}',
  '@media (max-width:720px){.wrap{padding:40px 16px 64px}h1{font-size:34px}.stats{grid-template-columns:1fr 1fr}.w2,.w3{grid-column:span 1}.w3:last-child{grid-column:span 2}section{margin-top:48px}}',
].join('');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/html.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Visual check**

Run:
```bash
npx tsx -e "import {makeReport} from './test/fixtures'; import {renderHtml} from './src/render/html'; const {report,samples}=makeReport(); require('fs').writeFileSync('/tmp/ci-telemetry-report.html', renderHtml(report,samples))" && open /tmp/ci-telemetry-report.html
```
(`npx tsx` downloads tsx on demand and is not a project dependency. On Linux, use `xdg-open` instead of `open`.) Check both light and dark mode (switch the OS appearance) and a width of 375px. Look for warm neutral surfaces, serif headline and figures, pastel pills, bands labelled with step names, no clipped axis labels, and tables that scroll horizontally on narrow screens. Fix anything that looks broken before committing.

- [ ] **Step 6: Commit**

```bash
git add src/render/html.ts test/html.test.ts
git commit -m "feat(action): render a self-contained HTML report in the minimalist-ui style"
```

---

### Task 17: Artifact naming and upload

**Files:**
- Create: `src/upload.ts`
- Test: `test/upload.test.ts`

**Interfaces:**
- Produces: `sanitizeName(s): string`, `defaultArtifactName(env, jobStartedAt: number): string`, `ArtifactUploader { uploadArtifact(name, files, rootDirectory, options?) }`, `isNameConflict(e): boolean`, `uploadWithRetry(client, name, files, rootDir, retentionDays, suffix?): Promise<{ id: number|null; name: string }>`, `artifactUrl(env, id): string|null`

- [ ] **Step 1: Write the failing tests**

`test/upload.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { artifactUrl, defaultArtifactName, sanitizeName, uploadWithRetry } from '../src/upload';

const env = { GITHUB_JOB: 'build', GITHUB_RUN_ATTEMPT: '2', RUNNER_NAME: 'GitHub Actions 3' };

describe('artifact names', () => {
  it('is deterministic and unique per runner (matrix legs)', () => {
    const a = defaultArtifactName(env, 1000);
    expect(a).toMatch(/^ci-telemetry-build-2-[0-9a-f]{6}$/);
    expect(defaultArtifactName(env, 1000)).toBe(a);
    expect(defaultArtifactName({ ...env, RUNNER_NAME: 'GitHub Actions 4' }, 1000)).not.toBe(a);
  });
  it('replaces characters artifact names cannot contain', () => {
    expect(sanitizeName('a/b:c<d>e|f*g?h"i\\j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });
});

describe('uploadWithRetry', () => {
  it('uploads once when the name is free', async () => {
    const calls: any[] = [];
    const client = { uploadArtifact: async (...a: any[]) => { calls.push(a); return { id: 5 }; } };
    expect(await uploadWithRetry(client, 'n', ['/d/f'], '/d', 7)).toEqual({ id: 5, name: 'n' });
    expect(calls).toEqual([['n', ['/d/f'], '/d', { retentionDays: 7 }]]);
  });

  it('retries once with a suffix on a name conflict', async () => {
    const names: string[] = [];
    const client = {
      uploadArtifact: async (name: string) => {
        names.push(name);
        if (names.length === 1) throw new Error('Failed to CreateArtifact: (409) Conflict: an artifact with this name already exists on the workflow run');
        return { id: 6 };
      },
    };
    expect(await uploadWithRetry(client, 'n', [], '/d', 7, () => 'beef')).toEqual({ id: 6, name: 'n-beef' });
    expect(names).toEqual(['n', 'n-beef']);
  });

  it('rethrows other errors', async () => {
    const client = { uploadArtifact: async () => { throw new Error('network down'); } };
    await expect(uploadWithRetry(client, 'n', [], '/d', 7)).rejects.toThrow('network down');
  });
});

describe('artifactUrl', () => {
  it('builds the run artifact URL when possible', () => {
    const e = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };
    expect(artifactUrl(e, 5)).toBe('https://github.com/o/r/actions/runs/9/artifacts/5');
    expect(artifactUrl({}, 5)).toBeNull();
    expect(artifactUrl(e, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/upload.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`src/upload.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

type Env = Record<string, string | undefined>;

export function sanitizeName(s: string): string {
  return s.replace(/[":<>|*?\r\n\\/]/g, '-');
}

/** ci-telemetry-<job>-<attempt>-<hash>; the hash separates matrix legs that share GITHUB_JOB. */
export function defaultArtifactName(env: Env, jobStartedAt: number): string {
  const h = createHash('sha1').update(`${env.RUNNER_NAME ?? ''}${jobStartedAt}`).digest('hex').slice(0, 6);
  return sanitizeName(`ci-telemetry-${env.GITHUB_JOB ?? 'job'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}-${h}`);
}

export interface ArtifactUploader {
  uploadArtifact(name: string, files: string[], rootDirectory: string, options?: { retentionDays?: number }): Promise<{ id?: number }>;
}

export function isNameConflict(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /already exists|\(409\)|Conflict/i.test(msg);
}

export async function uploadWithRetry(
  client: ArtifactUploader,
  name: string,
  files: string[],
  rootDir: string,
  retentionDays: number,
  suffix: () => string = () => randomBytes(2).toString('hex'),
): Promise<{ id: number | null; name: string }> {
  try {
    const r = await client.uploadArtifact(name, files, rootDir, { retentionDays });
    return { id: r.id ?? null, name };
  } catch (e) {
    if (!isNameConflict(e)) throw e;
    const retry = `${name}-${suffix()}`;
    const r = await client.uploadArtifact(retry, files, rootDir, { retentionDays });
    return { id: r.id ?? null, name: retry };
  }
}

export function artifactUrl(env: Env, id: number | null): string | null {
  if (id === null || !env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/artifacts/${id}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/upload.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/upload.ts test/upload.test.ts
git commit -m "feat(action): name and upload the artifact with conflict retry"
```

---

### Task 18: `main` and `post` orchestration, entry points, `action.yml` and the bundle

**Files:**
- Create: `src/main.ts`, `src/post.ts`, `src/entry/main.ts`, `src/entry/post.ts`, `action.yml`
- Create (generated): `dist/main/index.js`, `dist/post/index.js` (+ `licenses.txt`)
- Test: `test/main.test.ts`, `test/post.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 7–17
- Produces: `MainDeps`, `runMain(d: MainDeps): void`; `PostDeps`, `runPost(d: PostDeps): Promise<void>` (never rejects). State keys written by main and read by post: `enabled` (`'true'|'false'`, absent if start failed), `pid`, `dataDir`, `dataFile`, `startedAt` (epoch seconds).

**No action outputs.** The spec listed `artifact-id`, `artifact-url` and `report-path` as outputs. Outputs set in a `post` step can't be read by any later step, because there are none. So `action.yml` declares no outputs, and `post` logs the artifact name and URL instead. This is recorded in the plan header.

- [ ] **Step 1: Write the failing tests**

`test/main.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MainDeps, runMain } from '../src/main';
import { StartOptions } from '../src/collector-control';

function deps(o: Partial<MainDeps> = {}) {
  const state: Record<string, string> = {};
  const log = { notices: [] as string[], warnings: [] as string[], infos: [] as string[], starts: [] as StartOptions[] };
  const d: MainDeps = {
    platform: 'linux', arch: 'x64', pid: 100, binDir: '/a/dist/bin',
    env: { RUNNER_TEMP: '/rt', GITHUB_WORKSPACE: '/ws' },
    readInputs: () => ({ interval: 1, processInterval: 5, docker: true, githubToken: 't', artifactName: '', retentionDays: 7, jobSummary: true, htmlReport: true }),
    findWorker: () => 80,
    start: (s) => { log.starts.push(s); return { pid: 555, dataDir: '/rt/ci-telemetry/ab', dataFile: '/rt/ci-telemetry/ab/samples.ndjson' }; },
    saveState: (k, v) => { state[k] = v; },
    notice: (m) => log.notices.push(m), warning: (m) => log.warnings.push(m), info: (m) => log.infos.push(m),
    now: () => 1000,
    ...o,
  };
  return { d, state, log };
}

describe('runMain', () => {
  it('starts the collector and records state', () => {
    const { d, state, log } = deps();
    runMain(d);
    expect(log.starts[0]).toEqual({ binPath: '/a/dist/bin/collector-linux-x64', runnerTemp: '/rt', interval: 1, processInterval: 5, docker: true, watchPid: 80, workspace: '/ws' });
    expect(state).toEqual({ pid: '555', dataDir: '/rt/ci-telemetry/ab', dataFile: '/rt/ci-telemetry/ab/samples.ndjson', startedAt: '1000', enabled: 'true' });
    expect(log.warnings).toEqual([]);
  });

  it('no-ops with a notice on unsupported platforms', () => {
    const { d, state, log } = deps({ platform: 'darwin', arch: 'arm64' });
    runMain(d);
    expect(state).toEqual({ enabled: 'false' });
    expect(log.notices[0]).toContain('not supported on darwin/arm64');
    expect(log.starts).toEqual([]);
  });

  it('passes a null watch pid through in container jobs', () => {
    const { d, log } = deps({ findWorker: () => null });
    runMain(d);
    expect(log.starts[0].watchPid).toBeNull();
    expect(log.infos[0]).toContain('Runner.Worker is not visible');
  });

  it('turns start failures into a warning and leaves enabled unset', () => {
    const { d, state, log } = deps({ start: () => { throw new Error('failed to start collector at /x'); } });
    expect(() => runMain(d)).not.toThrow();
    expect(state.enabled).toBeUndefined();
    expect(log.warnings[0]).toBe('ci-telemetry: could not start telemetry: failed to start collector at /x');
  });
});
```

`test/post.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Inputs } from '../src/inputs';
import { PostDeps, runPost } from '../src/post';
import { makeEnd, makeSample, META, ndjson, T0 } from './fixtures';

const INPUTS: Inputs = { interval: 1, processInterval: 5, docker: true, githubToken: 't', artifactName: '', retentionDays: 7, jobSummary: true, htmlReport: true };
const SAMPLES = ndjson([META, makeSample(T0 + 1), makeSample(T0 + 2), makeEnd(T0 + 3)]);

function deps(o: Partial<PostDeps> = {}, state: Record<string, string> = { enabled: 'true', pid: '42', dataDir: '/d', dataFile: '/d/samples.ndjson', startedAt: String(T0) }) {
  const files: Record<string, string> = { '/d/samples.ndjson': SAMPLES };
  const log = { warnings: [] as string[], infos: [] as string[], summaries: [] as string[], uploads: [] as any[], stopped: [] as number[] };
  const d: PostDeps = {
    getState: (n) => state[n] ?? '',
    env: { GITHUB_JOB: 'build', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'r1', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' },
    inputs: INPUTS,
    stop: async (pid) => { log.stopped.push(pid); return 'stopped'; },
    readText: (f) => files[f] ?? null,
    writeText: (f, t) => { files[f] = t; },
    fetchSteps: async () => ({ steps: [{ name: 'Build', number: 1, conclusion: 'success', started_at: T0, completed_at: null }], jobName: 'build' }),
    readDmesg: async () => null,
    writeSummary: async (md) => { log.summaries.push(md); },
    upload: async (name, f, root, days) => { log.uploads.push({ name, files: f, root, days }); return { id: 123, name }; },
    warning: (m) => log.warnings.push(m),
    info: (m) => log.infos.push(m),
    now: () => T0 + 10,
    ...o,
  };
  return { d, files, log };
}

describe('runPost', () => {
  it('stops the collector, writes reports, summarises and uploads', async () => {
    const { d, files, log } = deps();
    await runPost(d);
    expect(log.stopped).toEqual([42]);
    const report = JSON.parse(files['/d/report.json']);
    expect(report.schema_version).toBe(1);
    expect(report.steps[0]).toMatchObject({ name: 'Build', samples: 2 });
    expect(files['/d/report.html']).toContain('<!doctype html>');
    expect(log.summaries[0]).toContain('## CI telemetry');
    expect(log.uploads[0].name).toMatch(/^ci-telemetry-build-1-[0-9a-f]{6}$/);
    expect(log.uploads[0].files).toEqual(['/d/report.json', '/d/samples.ndjson', '/d/report.html']);
    expect(log.uploads[0]).toMatchObject({ root: '/d', days: 7 });
    expect(log.infos.join('\n')).toContain('https://github.com/o/r/actions/runs/9/artifacts/123');
    expect(log.warnings).toEqual([]);
  });

  it('does nothing when main skipped an unsupported platform', async () => {
    const { d, log } = deps({}, { enabled: 'false' });
    await runPost(d);
    expect(log.stopped).toEqual([]);
    expect(log.summaries).toEqual([]);
    expect(log.uploads).toEqual([]);
  });

  it('writes an "unavailable" summary when main failed to start the collector', async () => {
    const { d, log } = deps({}, {});
    await runPost(d);
    expect(log.summaries[0]).toContain('Telemetry was unavailable for this job');
    expect(log.uploads).toEqual([]);
  });

  it('still uploads without a step breakdown when the API fails', async () => {
    const { d, files, log } = deps({ fetchSteps: async () => ({ steps: null, error: 'GitHub API returned 403' }) });
    await runPost(d);
    expect(JSON.parse(files['/d/report.json']).steps).toBeNull();
    expect(log.warnings[0]).toBe('ci-telemetry: per-step breakdown unavailable: GitHub API returned 403');
    expect(log.uploads).toHaveLength(1);
  });

  it('keeps the summary when upload fails', async () => {
    const { d, log } = deps({ upload: async () => { throw new Error('network down'); } });
    await runPost(d);
    expect(log.summaries).toHaveLength(1);
    expect(log.warnings).toEqual(['ci-telemetry: artifact upload failed: network down']);
  });

  it('respects job-summary/html-report inputs and sanitizes a custom name', async () => {
    const { d, log } = deps({ inputs: { ...INPUTS, jobSummary: false, htmlReport: false, artifactName: 'my/tele:metry' } });
    await runPost(d);
    expect(log.summaries).toEqual([]);
    expect(log.uploads[0].name).toBe('my-tele-metry');
    expect(log.uploads[0].files).toEqual(['/d/report.json', '/d/samples.ndjson']);
  });

  it('never rejects, even if a dependency throws unexpectedly', async () => {
    const { d, log } = deps({ readText: () => { throw new Error('EIO'); }, fetchSteps: () => Promise.reject(new Error('boom')) });
    await expect(runPost(d)).resolves.toBeUndefined();
    expect(log.warnings.join('\n')).toContain('EIO');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main.test.ts test/post.test.ts`
Expected: FAIL, the modules can't be resolved.

- [ ] **Step 3: Implement `runMain` and `runPost`**

`src/main.ts`:
```ts
import * as os from 'node:os';
import * as path from 'node:path';
import type { StartOptions, StartResult } from './collector-control';
import type { Inputs } from './inputs';
import { collectorBinaryName } from './runner';

export interface MainDeps {
  platform: string;
  arch: string;
  pid: number;
  binDir: string;
  env: Record<string, string | undefined>;
  readInputs(): Inputs;
  findWorker(pid: number): number | null;
  start(o: StartOptions): StartResult;
  saveState(name: string, value: string): void;
  notice(msg: string): void;
  warning(msg: string): void;
  info(msg: string): void;
  now(): number;
}

/** Never throws: telemetry must not fail the user's job. */
export function runMain(d: MainDeps): void {
  try {
    const bin = collectorBinaryName(d.platform, d.arch);
    if (!bin) {
      d.saveState('enabled', 'false');
      d.notice(`ci-telemetry: telemetry is not supported on ${d.platform}/${d.arch} yet; skipping.`);
      return;
    }
    const inputs = d.readInputs();
    const startedAt = d.now();
    const watchPid = d.findWorker(d.pid);
    if (watchPid === null) {
      d.info('ci-telemetry: Runner.Worker is not visible (container job?); the collector will run until the post step stops it.');
    }
    const res = d.start({
      binPath: path.join(d.binDir, bin),
      runnerTemp: d.env.RUNNER_TEMP || os.tmpdir(),
      interval: inputs.interval,
      processInterval: inputs.processInterval,
      docker: inputs.docker,
      watchPid,
      workspace: d.env.GITHUB_WORKSPACE,
    });
    d.saveState('pid', String(res.pid));
    d.saveState('dataDir', res.dataDir);
    d.saveState('dataFile', res.dataFile);
    d.saveState('startedAt', String(startedAt));
    d.saveState('enabled', 'true');
    d.info(`ci-telemetry: collector started (pid ${res.pid}), writing to ${res.dataFile}`);
  } catch (e) {
    d.warning(`ci-telemetry: could not start telemetry: ${(e as Error).message}`);
  }
}
```

`src/post.ts`:
```ts
import * as path from 'node:path';
import type { StopResult } from './collector-control';
import type { Inputs } from './inputs';
import { renderHtml } from './render/html';
import { renderSummary } from './render/summary';
import { buildReport } from './report';
import { parseSamples } from './samples';
import type { FetchStepsOptions, StepsResult } from './steps';
import { artifactUrl, defaultArtifactName, sanitizeName } from './upload';

export interface PostDeps {
  getState(name: string): string;
  env: Record<string, string | undefined>;
  inputs: Inputs;
  stop(pid: number): Promise<StopResult>;
  readText(file: string): string | null;
  writeText(file: string, text: string): void;
  fetchSteps(o: FetchStepsOptions): Promise<StepsResult>;
  readDmesg(): Promise<string | null>;
  writeSummary(markdown: string): Promise<void>;
  upload(name: string, files: string[], rootDir: string, retentionDays: number): Promise<{ id: number | null; name: string }>;
  warning(msg: string): void;
  info(msg: string): void;
  now(): number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const UNAVAILABLE = '## CI telemetry\n\n_Telemetry was unavailable for this job: the collector did not start. See the warnings in the ci-telemetry step._\n';

/** Never rejects: telemetry must not fail the user's job. */
export async function runPost(d: PostDeps): Promise<void> {
  try {
    await postInner(d);
  } catch (e) {
    d.warning(`ci-telemetry: ${msg(e)}`);
  }
}

async function postInner(d: PostDeps): Promise<void> {
  const enabled = d.getState('enabled');
  if (enabled === 'false') return;
  if (enabled !== 'true') {
    if (d.inputs.jobSummary) await d.writeSummary(UNAVAILABLE);
    return;
  }

  const pid = Number(d.getState('pid'));
  const dataDir = d.getState('dataDir');
  const dataFile = d.getState('dataFile');
  const startedAt = Number(d.getState('startedAt'));

  const stopResult = await d.stop(pid).catch((): StopResult => 'not-running');
  const raw = d.readText(dataFile);
  const parsed = parseSamples(raw ?? '');
  if (parsed.invalidLines) d.info(`ci-telemetry: skipped ${parsed.invalidLines} unreadable sample line(s)`);

  const steps = await d
    .fetchSteps({
      apiUrl: d.env.GITHUB_API_URL ?? 'https://api.github.com',
      token: d.inputs.githubToken,
      repository: d.env.GITHUB_REPOSITORY ?? '',
      runId: d.env.GITHUB_RUN_ID ?? '',
      runAttempt: d.env.GITHUB_RUN_ATTEMPT ?? '1',
      runnerName: d.env.RUNNER_NAME ?? '',
      jobStartedAt: startedAt,
    })
    .catch((e): StepsResult => ({ steps: null, error: msg(e) }));
  if (steps.error) d.warning(`ci-telemetry: per-step breakdown unavailable: ${steps.error}`);
  const dmesg = await d.readDmesg().catch(() => null);

  const report = buildReport({ parsed, steps, dmesg, stopResult, env: d.env, now: d.now() });
  const reportPath = path.join(dataDir, 'report.json');
  d.writeText(reportPath, JSON.stringify(report, null, 2));
  const files = [reportPath];
  if (raw !== null) files.push(dataFile);

  if (d.inputs.htmlReport) {
    try {
      const htmlPath = path.join(dataDir, 'report.html');
      d.writeText(htmlPath, renderHtml(report, parsed.samples));
      files.push(htmlPath);
    } catch (e) {
      d.warning(`ci-telemetry: could not render the HTML report: ${msg(e)}`);
    }
  }

  if (d.inputs.jobSummary) {
    try {
      await d.writeSummary(renderSummary(report));
    } catch (e) {
      d.warning(`ci-telemetry: could not write the job summary: ${msg(e)}`);
    }
  }

  try {
    const name = d.inputs.artifactName ? sanitizeName(d.inputs.artifactName) : defaultArtifactName(d.env, startedAt);
    const up = await d.upload(name, files, dataDir, d.inputs.retentionDays);
    const url = artifactUrl(d.env, up.id);
    d.info(`ci-telemetry: uploaded artifact '${up.name}'${url ? ` → ${url}` : ''}`);
  } catch (e) {
    d.warning(`ci-telemetry: artifact upload failed: ${msg(e)}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass.

- [ ] **Step 5: Entry points and `action.yml`**

`src/entry/main.ts`:
```ts
import * as core from '@actions/core';
import * as path from 'node:path';
import { startCollector } from '../collector-control';
import { readInputs } from '../inputs';
import { runMain } from '../main';
import { findRunnerWorkerPid } from '../runner';

runMain({
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  binDir: path.join(__dirname, '..', 'bin'), // dist/main/index.js → dist/bin
  env: process.env,
  readInputs: () => readInputs(),
  findWorker: (pid) => findRunnerWorkerPid(pid),
  start: (o) => startCollector(o),
  saveState: core.saveState,
  notice: (m) => core.notice(m),
  warning: (m) => core.warning(m),
  info: core.info,
  now: () => Date.now() / 1000,
});
```

`src/entry/post.ts`:
```ts
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import * as fs from 'node:fs';
import { stopCollector } from '../collector-control';
import { readInputs } from '../inputs';
import { readDmesg } from '../oom';
import { runPost } from '../post';
import { fetchSteps } from '../steps';
import { uploadWithRetry } from '../upload';

const client = new DefaultArtifactClient();

runPost({
  getState: core.getState,
  env: process.env,
  inputs: readInputs(core.getInput, () => {}), // main already warned about bad inputs
  stop: (pid) => stopCollector(pid),
  readText: (f) => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
  },
  writeText: (f, t) => fs.writeFileSync(f, t),
  fetchSteps,
  readDmesg: () => readDmesg(),
  writeSummary: async (md) => { await core.summary.addRaw(md).write(); },
  upload: (name, files, root, days) => uploadWithRetry(client, name, files, root, days),
  warning: (m) => core.warning(m),
  info: core.info,
  now: () => Date.now() / 1000,
}).catch(() => {});
```

`action.yml`:
```yaml
name: 'CI Job Telemetry'
description: 'Per-step CPU, memory, pressure, disk, network and Docker telemetry for a job, collected by a ~2 MB Rust sidecar and uploaded as an artifact.'
branding:
  icon: 'activity'
  color: 'gray-dark'
inputs:
  interval:
    description: 'Seconds between samples (1-60).'
    required: false
    default: '1'
  process-interval:
    description: 'Seconds between top-process snapshots (0 disables, max 300).'
    required: false
    default: '5'
  docker:
    description: 'Collect per-container CPU, memory, I/O and OOM stats from Docker cgroups.'
    required: false
    default: 'true'
  github-token:
    description: 'Token used once, in the post step, to read step timings. Needs `actions: read`.'
    required: false
    default: '${{ github.token }}'
  artifact-name:
    description: 'Artifact name. Default: ci-telemetry-<job>-<attempt>-<hash>.'
    required: false
    default: ''
  retention-days:
    description: 'Artifact retention in days (1-90).'
    required: false
    default: '7'
  job-summary:
    description: 'Write a per-step table and findings to the job summary.'
    required: false
    default: 'true'
  html-report:
    description: 'Include a self-contained report.html in the artifact.'
    required: false
    default: 'true'
runs:
  using: 'node24'
  main: 'dist/main/index.js'
  post: 'dist/post/index.js'
  post-if: 'always()'
```

- [ ] **Step 6: Build and check the bundle**

Run: `npm run build && ls dist/main dist/post && node -e "require('./dist/post/index.js')"; echo "exit=$?"`
Expected: both `index.js` files exist. Requiring the post bundle outside Actions finds no state (`enabled` is empty), so it tries to write the "unavailable" summary. `core.summary` then fails without `GITHUB_STEP_SUMMARY`; that failure is caught as a warning, and the output is `exit=0`.

- [ ] **Step 7: Commit** (the bundle is committed, as Marketplace actions require)

```bash
git add src test action.yml dist/main dist/post
git commit -m "feat(action): wire main/post entry points, action.yml and ncc bundle"
```

---

## Part C: Delivery

### Task 19: CI and end-to-end workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`, `.github/actions/prepare-e2e/action.yml`, `scripts/verify-e2e.mjs`

**Interfaces:**
- Consumes: the whole action. E2E artifacts use the default name, so the `ci-telemetry-<job id>-` prefix identifies each scenario.

**Note on container OOMs:** Docker removes a container's cgroup the moment it exits. The collector samples containers every 2 s, so a container whose **main process** is OOM-killed usually disappears before its `oom_kill` counter is read. In that case the kernel `dmesg` event (source `kernel`) is the signal. The container-OOM scenario therefore kills a **child** process and leaves PID 1 alive, which is also what really happens when, for example, one Postgres backend is killed.

- [ ] **Step 1: `ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
jobs:
  rust:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: collector } }
    steps:
      - uses: actions/checkout@v4
      - run: cargo fmt --check
      - run: cargo clippy --all-targets --locked -- -D warnings
      - run: cargo test --locked
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: Committed dist/ matches a fresh build
        run: git diff --exit-code -- dist/main dist/post || { echo "::error::dist/ is stale. Run 'npm run build' and commit the result."; exit 1; }
```

- [ ] **Step 2: `prepare-e2e` composite action**

`.github/actions/prepare-e2e/action.yml`:
```yaml
name: prepare-e2e
description: Places freshly built collector binaries and JS bundles into dist/ for `uses: ./`
runs:
  using: composite
  steps:
    - uses: actions/download-artifact@v4
      with: { pattern: e2e-bin-*, path: dist/bin, merge-multiple: true }
    - uses: actions/download-artifact@v4
      with: { name: e2e-js, path: dist }
    - shell: bash
      run: chmod +x dist/bin/*
```

- [ ] **Step 3: `e2e.yml`**

```yaml
name: e2e
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
jobs:
  build:
    strategy:
      matrix:
        include:
          - { runner: ubuntu-latest, arch: x64, target: x86_64-unknown-linux-musl }
          - { runner: ubuntu-24.04-arm, arch: arm64, target: aarch64-unknown-linux-musl }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update -q && sudo apt-get install -yq musl-tools
      - run: rustup target add ${{ matrix.target }}
      - run: cargo build --release --locked --target ${{ matrix.target }}
        working-directory: collector
      - run: mkdir -p out && cp collector/target/${{ matrix.target }}/release/collector out/collector-linux-${{ matrix.arch }}
      - uses: actions/upload-artifact@v4
        with: { name: 'e2e-bin-${{ matrix.arch }}', path: out/, retention-days: 1 }
      - if: matrix.arch == 'x64'
        uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - if: matrix.arch == 'x64'
        run: npm ci && npm run build
      - if: matrix.arch == 'x64'
        uses: actions/upload-artifact@v4
        with:
          name: e2e-js
          retention-days: 1
          path: |
            dist/main
            dist/post

  normal:
    needs: build
    strategy: { matrix: { runner: [ubuntu-latest, ubuntu-24.04-arm] } }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - uses: ./
      - name: Busy work
        run: |
          for i in 1 2 3; do (yes > /dev/null & P=$!; sleep 3; kill $P); done
          dd if=/dev/zero of=big bs=1M count=200 conv=fdatasync && rm big

  failing-step:
    needs: build
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - uses: ./
      - run: sleep 3 && exit 1

  host-oom:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - uses: ./
      - name: Trigger host OOM
        run: |
          sleep 3
          sudo systemd-run --scope -p MemoryMax=200M -p MemorySwapMax=0 python3 -c "a = bytearray(400 * 1024 * 1024)" || true
          sleep 3

  container-oom:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - run: docker pull -q python:3.12-alpine
      - uses: ./
      - name: Trigger container OOM
        run: docker run --name oomy -m 64m --memory-swap 64m python:3.12-alpine sh -c "sleep 3; python -c 'a = bytearray(200 * 1024 * 1024)'; sleep 6"

  service-container:
    needs: build
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        options: --health-cmd pg_isready --health-interval 2s --health-timeout 5s --health-retries 15
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - uses: ./
      - run: sleep 10

  no-permissions:
    needs: build
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - uses: ./
      - run: sleep 3

  overhead:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/prepare-e2e
      - run: sudo apt-get update -q && sudo apt-get install -yq stress-ng
      - uses: ./
      - run: stress-ng --cpu 1 --vm 1 --vm-bytes 256M --timeout 300s --metrics-brief

  verify:
    needs: [normal, failing-step, host-oom, container-oom, service-container, no-permissions, overhead]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - uses: actions/download-artifact@v4
        with: { pattern: ci-telemetry-*, path: artifacts }
      - run: node scripts/verify-e2e.mjs artifacts
```

- [ ] **Step 4: `scripts/verify-e2e.mjs`**

```js
// Validates every downloaded e2e artifact against the schema and each scenario's expectations.
import Ajv from 'ajv';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'artifacts';
const failures = [];
const expect = (cond, msg) => { if (!cond) failures.push(msg); };

const schema = JSON.parse(readFileSync('schema/report.schema.json', 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

const reports = {};
for (const dir of readdirSync(root)) {
  const file = join(root, dir, 'report.json');
  if (!existsSync(file)) { failures.push(`${dir}: report.json missing`); continue; }
  const r = JSON.parse(readFileSync(file, 'utf8'));
  if (!validate(r)) failures.push(`${dir}: schema errors ${JSON.stringify(validate.errors)}`);
  expect(existsSync(join(root, dir, 'report.html')), `${dir}: report.html missing`);
  expect(existsSync(join(root, dir, 'samples.ndjson')), `${dir}: samples.ndjson missing`);
  reports[dir] = r;
}
const of = (job) => Object.entries(reports).filter(([n]) => n.startsWith(`ci-telemetry-${job}-`)).map(([, r]) => r);

const normal = of('normal');
expect(normal.length === 2, `normal: expected 2 artifacts (x64 + arm64, distinct names), got ${normal.length}`);
for (const r of normal) {
  expect(Array.isArray(r.steps) && r.steps.some((s) => s.name === 'Busy work' && s.samples > 0 && s.cpu_max > 20), 'normal: "Busy work" step with CPU load');
  expect(r.collector.end_reason === 'sigterm', `normal: end_reason ${r.collector.end_reason}`);
}

expect(of('failing-step').length === 1, 'failing-step: post must still upload after a failed step');

const hostOom = of('host-oom')[0];
expect(hostOom?.oom_events.some((e) => e.source === 'kernel' && e.step === 'Trigger host OOM'), 'host-oom: kernel OOM event attributed to the OOM step');

const ctrOom = of('container-oom')[0];
expect(ctrOom?.containers.some((c) => c.name === 'oomy' && c.oom_kills >= 1), 'container-oom: container "oomy" with oom_kills >= 1');
expect(ctrOom?.oom_events.some((e) => e.source === 'container'), 'container-oom: container OOM event');

const svc = of('service-container')[0];
expect(svc?.containers.some((c) => (c.image ?? '').startsWith('postgres:16')), 'service-container: postgres:16 container');

const noPerm = of('no-permissions')[0];
expect(noPerm && noPerm.steps === null && typeof noPerm.steps_error === 'string', 'no-permissions: steps null with steps_error');

const oh = of('overhead')[0];
expect(oh?.collector.peak_rss != null && oh.collector.peak_rss <= 5 * 1024 * 1024, `overhead: peak_rss ${oh?.collector.peak_rss} > 5 MiB`);
expect(oh?.collector.avg_cpu_pct != null && oh.collector.avg_cpu_pct <= 0.5, `overhead: avg_cpu_pct ${oh?.collector.avg_cpu_pct} > 0.5`);

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✓ verified ${Object.keys(reports).length} reports`);
```

- [ ] **Step 5: Validate locally**

Run: `npx --yes @action-validator/cli .github/workflows/ci.yml && npx --yes @action-validator/cli .github/workflows/e2e.yml && npx --yes @action-validator/cli action.yml`
Expected: no errors. The real check is the first run of `e2e` on GitHub after the push (Task 20, Step 5).

- [ ] **Step 6: Commit**

```bash
git add .github scripts
git commit -m "ci: add unit CI and end-to-end scenario workflows"
```

---

### Task 20: Release workflow, README and LICENSE

**Files:**
- Create: `.github/workflows/release.yml`, `README.md`, `LICENSE`

- [ ] **Step 1: `release.yml`**

```yaml
name: release
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to release, X.Y.Z'
        required: true
permissions:
  contents: read
jobs:
  build:
    strategy:
      matrix:
        include:
          - { runner: ubuntu-latest, arch: x64, target: x86_64-unknown-linux-musl }
          - { runner: ubuntu-24.04-arm, arch: arm64, target: aarch64-unknown-linux-musl }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update -q && sudo apt-get install -yq musl-tools
      - run: rustup target add ${{ matrix.target }}
      - run: cargo build --release --locked --target ${{ matrix.target }}
        working-directory: collector
      - run: mkdir -p out && cp collector/target/${{ matrix.target }}/release/collector out/collector-linux-${{ matrix.arch }}
      - uses: actions/upload-artifact@v4
        with: { name: 'bin-${{ matrix.arch }}', path: out/ }

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
    env:
      VERSION: ${{ inputs.version }}
    steps:
      - name: Validate version
        run: '[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::version must be X.Y.Z"; exit 1; }'
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci && npm test && npm run build
      - uses: actions/download-artifact@v4
        with: { pattern: bin-*, path: dist/bin, merge-multiple: true }
      - run: chmod +x dist/bin/* && ls -l dist/bin
      - uses: actions/attest-build-provenance@v2
        with: { subject-path: 'dist/bin/*' }
      - name: Commit binaries on a tag-only commit and move the major tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout --detach
          git add -f dist/bin dist/main dist/post
          git commit -m "release: v$VERSION"
          git tag "v$VERSION"
          git tag -f "v${VERSION%%.*}"
          git push origin "v$VERSION"
          git push -f origin "v${VERSION%%.*}"
      - run: gh release create "v$VERSION" --verify-tag --generate-notes dist/bin/*
        env: { GH_TOKEN: '${{ github.token }}' }
```

- [ ] **Step 2: `README.md`**

Write it with these sections, in this order, using the exact values from the Global Constraints:
1. **What it does:** one paragraph, plus a screenshot placeholder line `![Report](docs/report.png)`. Save the Task 16 visual-check render as `docs/report.png` and commit it.
2. **Usage:**
   ```yaml
   jobs:
     build:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         actions: read   # step timings
       steps:
         - uses: <owner>/ci-telemetry@v1   # first step
         - uses: actions/checkout@v4
         - run: make build
   ```
3. **Inputs:** a table of all 8 inputs with their defaults and ranges.
4. **What's collected:** the metric table from spec §3, with CPU units stated (host % of all cores; process and container % of one core).
5. **Artifact contents:** `samples.ndjson`, `report.json` (link to `schema/report.schema.json`), `report.html`.
6. **Overhead:** the ≤ 5 MB RSS and ≤ 0.5% CPU budget, the `nice 19` / `oom_score_adj 1000` behaviour, and a note that each report's `collector` block records the actual figures for that run.
7. **Permissions and graceful degradation:** `actions: read` for step timings; passwordless `sudo` for kernel OOM detection; the Docker socket for container names. List what is missing when each is unavailable.
8. **Limitations:** copy spec §6, plus the GHES non-support, Linux-only, and the container-OOM cgroup timing note from Task 19.
9. **Verifying the binaries:** `gh attestation verify dist/bin/collector-linux-x64 --repo <owner>/ci-telemetry`.
10. **Development:** `npm ci && npm test`, `cd collector && cargo test`, `npm run build`, and a warning that `dist/` must be committed.

Replace `<owner>` everywhere once the publishing account is chosen. That is an open decision for the user, so ask before publishing.

- [ ] **Step 3: `LICENSE`**

Standard MIT text with the line `Copyright (c) 2026 ci-telemetry contributors`. Confirm the copyright holder with the user before the first release.

- [ ] **Step 4: Final full verification**

Run:
```bash
npm ci && npm run typecheck && npm test && npm run build && git diff --exit-code -- dist/main dist/post
(cd collector && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked)
```
Expected: everything passes, and there is no diff in `dist/`.

- [ ] **Step 5: Commit, push and watch e2e**

```bash
git add .github/workflows/release.yml README.md LICENSE docs/report.png
git commit -m "docs: add README, license and release workflow"
```
Pushing to GitHub is an outward-facing action, so get the user's go-ahead first. Then push to a branch, open a PR, and confirm that `ci` and `e2e` are green, including the `verify` job. Paste `verify`'s output into the PR description.

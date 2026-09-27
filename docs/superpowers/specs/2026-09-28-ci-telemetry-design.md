# ci-telemetry — Design Spec

- **Date:** 2026-09-28
- **Status:** Draft, awaiting review
- **Distribution:** Public GitHub Marketplace action

## 1. Purpose

A GitHub Action that records resource telemetry for the whole lifecycle of a CI job and uploads it as a workflow artifact at the end, so users can answer performance-tuning questions:

- Which step is slow, and is it CPU-, memory-, disk- or network-bound?
- Is the runner undersized (memory/CPU pressure, OOM kills)?
- What did Docker containers (services, `docker build`, `docker run`) consume?

### Success criteria

1. Adding one step (`uses: <owner>/ci-telemetry@v1`) at the top of a job is the only setup required.
2. The action **never** causes the user's job to fail and never makes network calls while the job's own steps are running.
3. Collector overhead on a 1 vCPU / 2 GB runner: **peak RSS ≤ 5 MB, average CPU ≤ 0.5%** (enforced in CI).
4. If a step is OOM-killed, the artifact is still uploaded and the report shows the kill and the step it happened in.
5. Each report has a per-step breakdown (duration, CPU, memory, pressure, I/O), a per-container breakdown, and a human-readable HTML report plus job summary.

### Non-goals (v1)

- Security/audit telemetry (network connections, file access).
- Surviving a runner-level crash (VM dies or the runner agent is killed). No step can run after that.
- Streaming data off the machine during the job.
- macOS and Windows collection (the action no-ops there).
- GitHub Enterprise Server (the `@actions/artifact` v2 client does not support GHES).
- Per-container network stats.
- Metrics for the "Set up job" / "Initialize containers" phases, which run before any user step. Only their durations are reported, taken from the API.

## 2. Architecture

A **JavaScript action** (`runs.using: node24`) with `main` and `post` entry points, plus a **Rust collector binary** that runs in the background for the rest of the job.

```
action.yml   runs: { using: node24, main: dist/main/index.js, post: dist/post/index.js }

main (the step at the top of the job; runs in under 1 s)
  ├─ exits with a notice if process.platform !== 'linux'
  ├─ reads and validates the inputs
  ├─ finds the Runner.Worker PID (walks the ppid chain via /proc/<pid>/comm; falls back to process.ppid)
  ├─ spawns dist/bin/collector-linux-<arch> detached, stdio ignored, unref()
  └─ core.saveState: collector PID, data dir, job start time

collector (Rust, static musl binary, background process for the whole job)
  ├─ at startup: setpriority(nice 19); writes 1000 to /proc/self/oom_score_adj
  ├─ writes a `meta` record, then every tick appends a `sample` record
  │   to $RUNNER_TEMP/ci-telemetry/samples.ndjson
  ├─ exits by itself if the watch-pid disappears or the maximum duration elapses
  └─ on SIGTERM: writes an `end` record (with its own resource usage), then exits 0

post (runs automatically at job end, even when earlier steps failed)
  ├─ SIGTERM to the collector; waits up to 2 s; SIGKILL if still alive
  ├─ parses samples.ndjson (drops a half-written last line)
  ├─ one API call for step timings (optional, may fail)
  ├─ sudo -n dmesg for OOM kills (optional, may fail)
  ├─ builds report.json, report.html and the job summary
  └─ uploads the artifact (@actions/artifact v2); sets outputs
```

### Why this split

- Only JavaScript actions get a `post` hook on every runner type. Composite actions have none, and Docker actions are Linux-only and slow to start.
- `main` and `post` are short-lived, so Node's roughly 40 MB footprint does not matter there. The collector runs for the whole job on runners as small as 1 vCPU / 2 GB, so it is a small Rust binary (about 1–2 MB RSS).
- The NDJSON file is the only interface between the collector and `post`. The collector could be replaced without changing anything else.

## 3. Collector (Rust)

### CLI

```
collector --out <file> --interval <secs> --proc-interval <secs|0>
          --docker <true|false> --watch-pid <pid>
          --max-bytes 52428800 --max-duration 72h
```

### Behaviour

- **Reads only procfs, sysfs and statvfs.** It spawns no child processes. The only socket use is the Docker name lookup (below).
- **Tick loop:** on each tick, read the sources, compute rates from the previous tick's counters (handling counter wraparound and resets), write one line, then call `posix_fadvise(DONTNEED)` on the written range so the data does not fill the page cache.
- **Watchdog:** each tick it checks whether `/proc/<watch-pid>` exists and exits if not. It also exits after `--max-duration`.
- **Size cap:** when the file passes `--max-bytes`, the effective interval doubles (and again at 2× the cap, and so on). A `downsample` record notes each change.
- **Missing sources** (no PSI, cgroup v1, no Docker socket) are recorded once in `meta.capabilities` and then skipped. The collector never exits because of a missing source.
- **Build targets:** `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. Static linking means the binaries also run inside Alpine-based job containers.

### Metrics

| Group | Fields | Source | Cadence |
|---|---|---|---|
| CPU | `usr`, `sys`, `iow`, `steal` (% of all CPUs) | `/proc/stat` | every tick |
| Load | `load1` | `/proc/loadavg` | every tick |
| Memory | `used`, `avail`, `cached`, `swap` (bytes) | `/proc/meminfo` | every tick |
| Pressure | `cpu_some`, `mem_some`, `mem_full`, `io_some`, `io_full` (avg10 %) | `/proc/pressure/*` | every tick |
| Disk I/O | `rd`, `wr` (bytes/s, whole disks only, no partitions or loop devices) | `/proc/diskstats` | every tick |
| Network | `rx`, `tx` (bytes/s, excluding `lo`) | `/proc/net/dev` | every tick |
| Filesystem | free bytes on `/` and on `$GITHUB_WORKSPACE` | `statvfs` | every 10 s |
| Processes | top 5 by CPU% and top 5 by RSS: `pid`, `comm`, `cpu`, `rss` | `/proc/[pid]/stat`, `statm` | `--proc-interval` (default 5 s) |
| Containers | `id`, `cpu`, `mem`, `mem_peak`, `io_rd`, `io_wr`, `oom_kills` | cgroup v2 `docker-<id>.scope/{cpu.stat,memory.current,memory.peak,memory.events,io.stat}` | every 2 s |

**Container discovery:** list `/sys/fs/cgroup/system.slice/docker-*.scope` on each container tick. The first time an ID is seen, the collector sends `GET /containers/{id}/json` over `/var/run/docker.sock` with a 500 ms timeout and a minimal hand-written HTTP/1.0 request, then caches `name` and `image`. The container is written as a `container` record. If the lookup fails, the report uses the 12-character short ID.

### Record format (NDJSON, one JSON object per line)

```jsonc
{"type":"meta","v":1,"t":1759050000.000,"interval":1,"cpus":1,"mem_total":2084000000,
 "kernel":"6.8.0-1015-azure","arch":"x86_64","cgroup":"v2",
 "capabilities":{"psi":true,"docker_cgroups":true,"docker_socket":true}}
{"type":"sample","t":1759050001.002,"cpu":{"usr":41.2,"sys":6.3,"iow":0.8,"steal":0.0},"load1":0.92,
 "mem":{"used":812000000,"avail":1190000000,"cached":400000000,"swap":0},
 "psi":{"cpu_some":3.1,"mem_some":0.0,"mem_full":0.0,"io_some":0.4,"io_full":0.1},
 "disk":{"rd":0,"wr":1048576},"net":{"rx":2048,"tx":512},
 "fs":{"root_free":20000000000,"ws_free":20000000000},          // only on fs ticks
 "procs":{"cpu":[{"pid":123,"comm":"node","cpu":38.0,"rss":210000000}],"rss":[...]}, // only on proc ticks
 "ctr":[{"id":"3f2a…","cpu":12.0,"mem":90000000,"mem_peak":95000000,"io_rd":0,"io_wr":4096,"oom_kills":0}]}
{"type":"container","t":1759050003.0,"id":"3f2a…","name":"db","image":"postgres:16"}
{"type":"downsample","t":1759060000.0,"interval":2}
{"type":"end","t":1759053600.0,"reason":"sigterm","self":{"peak_rss":1800000,"cpu_seconds":4.2}}
```

`end.reason` is one of `sigterm`, `watch-pid-gone` or `max-duration`. If there is no `end` record, the collector died, most likely from an OOM kill.

## 4. main / post (TypeScript)

### Inputs

| Input | Default | Validation / notes |
|---|---|---|
| `interval` | `1` | number, 1–60 |
| `process-interval` | `5` | number, 0–300 (0 disables) |
| `docker` | `true` | boolean |
| `github-token` | `${{ github.token }}` | used only for the step-timing call |
| `artifact-name` | `''` → auto | see naming below |
| `retention-days` | `7` | 1–90 |
| `job-summary` | `true` | boolean |
| `html-report` | `true` | boolean |

Invalid values are replaced by the default and produce a warning. They never cause a failure.

### Outputs

`artifact-id`, `artifact-url`, `report-path` (the local path to `report.json`).

### Artifact naming

The default is `ci-telemetry-${GITHUB_JOB}-${GITHUB_RUN_ATTEMPT}-${h}`, where `h` is the first 6 hex characters of `sha1(RUNNER_NAME + jobStartTime)`. This keeps names unique across matrix legs. If the upload fails because the name already exists, it retries once with a random 4-character suffix added.

### Step timings

- `GET {GITHUB_API_URL}/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{run_attempt}/jobs?per_page=100`, following pagination.
- The current job is the one with `status == in_progress` and `runner_name == RUNNER_NAME`. If several match, take the one whose `started_at` is closest to the job start time recorded by `main`.
- Each sample is assigned to the step whose `[started_at, completed_at)` range contains its timestamp. API times have 1-second resolution, and that limit is accepted. The `post` step itself (still in progress) is labelled "Post telemetry".
- On any failure (401, 403, 404, network, timeout after 10 s), log a warning and produce the report without a step breakdown. `report.json` then has `steps: null` and `steps_error: "<reason>"`.

### OOM detection

1. **Per container:** increases in `oom_kills` in the container samples.
2. **Host/step level:** run `sudo -n dmesg --time-format iso` with a 3 s timeout, and parse `Out of memory: Killed process <pid> (<comm>)` and `oom-kill:` lines whose timestamps fall inside the job window. If this fails, record `capabilities.dmesg = false` and skip it.
3. **Collector killed:** there is no `end` record. Report "collector terminated early at <last sample time>".

Each OOM event records its time, killed process, source (`container` / `kernel` / `collector`) and step (if known).

### Warnings (heuristics)

These appear in the job summary and in `report.json.findings`:

| Condition | Level |
|---|---|
| Any OOM event | 🔴 error |
| Step with duration ≥ 30 s and max `mem_full` ≥ 10% | ⚠️ "memory-starved, the runner is probably undersized" |
| Step with duration ≥ 30 s and average `usr+sys` ≥ 90% | ⚠️ "CPU-bound" |
| Step with duration ≥ 30 s and max `io_full` ≥ 20% | ⚠️ "I/O-bound" |
| Average `steal` over the job ≥ 5% | ⚠️ "noisy neighbour / host contention" |
| Minimum free space on `/` or the workspace < 1 GiB | ⚠️ "disk nearly full" |
| Swap increased during the job | ⚠️ "swapping" |

All thresholds are constants in one module. They are not inputs in v1.

### Artifact contents

- `samples.ndjson`: the raw collector output.
- `report.json`: `{ schema_version, job{…}, runner{cpus, mem_total, os, arch, kernel}, capabilities{…}, steps[…]|null, steps_error?, containers[…], oom_events[…], findings[…], collector{peak_rss, cpu_seconds, avg_cpu_pct, end_reason} }`. A JSON Schema for it lives at `schema/report.schema.json`.
  - Each step: `name, number, conclusion, started_at, completed_at, duration_s, cpu_avg, cpu_max, mem_peak, psi_max{…}, disk_rd, disk_wr, net_rx, net_tx`.
  - Each container: `id, name, image, first_seen, last_seen, cpu_avg, cpu_max, mem_peak, oom_kills`.
- `report.html` (if `html-report` is set): one self-contained file with inline CSS and hand-generated inline SVG. It uses no external resources and no JavaScript libraries. It has time-series charts for CPU, memory, PSI, disk and network with labelled step bands, OOM markers in red, a stacked container-memory chart, and the step and container tables. Series with more than 2,000 points are downsampled for plotting using min/max bucketing, so spikes are kept.

### Job summary

When `job-summary` is set, `post` writes four things to `$GITHUB_STEP_SUMMARY`: a header line (runner size, total duration, collector overhead), a table with one row per step, a table with one row per container (if there are any), and the list of findings.

## 5. Error-handling rules

1. `main` and `post` have a top-level try/catch. Errors are reported only with `core.warning`, and the process never exits with a non-zero code.
2. If `main` failed to start the collector, `post` still runs. It uploads whatever it has, or writes a short summary saying telemetry was unavailable.
3. Each optional source (API, dmesg, Docker socket, PSI, cgroups) degrades on its own and is recorded in `capabilities`.
4. If the artifact upload fails, log a warning. The report is still written to the job summary and to `report-path`.

## 6. Known limitations

- **Container jobs (`container:`):** `main`, `post` and the collector run inside the job container. `/proc/stat` and `/proc/meminfo` still show the VM's totals, which is useful. Sibling containers' cgroups and the Docker socket are usually not visible, so per-container stats and name lookups are unavailable (recorded in `capabilities`). `dmesg` is normally unavailable too.
- Step boundaries have 1-second resolution (API limit).
- Metrics start when the action's step runs. Work done in steps before it is not sampled.

## 7. Repository layout

```
action.yml
package.json  tsconfig.json  vitest.config.ts
src/
  main.ts                 # entry: spawn collector
  post.ts                 # entry: stop, report, upload
  inputs.ts               # parse and validate inputs
  runner.ts               # platform/arch detection, Runner.Worker PID lookup
  collector-control.ts    # spawn / stop
  samples.ts              # NDJSON parsing into typed records
  steps.ts                # API fetch and current-job selection
  oom.ts                  # dmesg parsing and OOM event merging
  aggregate.ts            # per-step and per-container statistics
  findings.ts             # heuristics
  render/summary.ts       # Markdown job summary
  render/html.ts          # self-contained HTML plus SVG charts
  upload.ts               # artifact naming and upload with retry
collector/
  Cargo.toml
  src/main.rs  cli.rs  sources/{cpu,mem,psi,disk,net,fs,procs,cgroup,docker}.rs  writer.rs
  tests/fixtures/…        # real procfs/sysfs captures
schema/report.schema.json
dist/                     # committed: ncc bundles and bin/collector-linux-{x64,arm64}
.github/workflows/ci.yml  e2e.yml  release.yml
```

## 8. Testing

### Rust (`cargo test`, `cargo clippy -D warnings`)

- Parsers tested against real fixtures from Ubuntu 22.04/24.04, x64/arm64, cgroup v1/v2, and kernels without PSI.
- Rate calculation, counter wraparound and resets, downsampling at the size cap, watchdog exit, and SIGTERM writing the `end` record.

### TypeScript (Vitest)

- Input validation and fallback to defaults.
- NDJSON parsing with a truncated last line and a missing `end` record.
- Current-job selection (pagination, multiple candidates) and API failures (401, 403, 404, timeout).
- Sample-to-step assignment at boundaries.
- `dmesg` OOM line parsing, including time-window filtering.
- Findings thresholds, artifact-name generation, and retry when the name already exists.
- Snapshot tests for the summary Markdown, plus a structural check of the HTML (well-formed, no external URLs).

### End-to-end (`e2e.yml`, `uses: ./`, on `ubuntu-latest` and `ubuntu-24.04-arm`)

| Scenario | Assertion |
|---|---|
| Normal job | Artifact exists, is valid against the schema, and has steps |
| A step that fails | `post` still uploads |
| Host OOM in a step (`systemd-run --scope -p MemoryMax=200M stress-ng --vm 1 --vm-bytes 400M`) | `oom_events` has a `kernel` event assigned to that step |
| Container OOM (`docker run -m 64m …`) | Container `oom_kills ≥ 1`, and an OOM event from the `container` source |
| Service container (postgres) | Container appears with its name and image |
| 2-leg matrix | Two artifacts with distinct names |
| `permissions: {}` token | Report has `steps: null` and a `steps_error`; job passes |
| Overhead budget: 5-minute CPU and memory workload on the smallest runner | `collector.peak_rss ≤ 5 MB` and `avg_cpu_pct ≤ 0.5` |

A final job downloads every artifact and validates it against `schema/report.schema.json`.

## 9. Release

- `ci.yml` runs lint, unit tests and `cargo test`, and checks that `dist/` matches a fresh build (`npm run build` produces no diff).
- `release.yml` is started manually (`workflow_dispatch` with a `version` input), because the tag must point at a commit that already contains the binaries. It cross-compiles both musl targets, strips them, commits them to `dist/bin/`, tags that commit `vX.Y.Z`, generates `actions/attest-build-provenance` attestations, publishes the GitHub release, and moves the major-version tag (`v1`).

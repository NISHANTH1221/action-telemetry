# ci-telemetry

A GitHub Action that records CPU, memory, pressure, disk, network and Docker
telemetry for the whole lifecycle of a CI job, and uploads it as a workflow
artifact when the job finishes — a per-step and per-container breakdown, a
self-contained HTML report, and a job summary, so you can tell which step is
slow and why, and whether the runner itself is undersized. A ~2 MB Rust
sidecar does the sampling in the background; the action itself never fails
the job and never makes a network call while your steps are running.

![Report](docs/report.png)

## Usage

Add it as the **first** step of the job:

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

## Inputs

| Input | Default | Range / notes |
|---|---|---|
| `interval` | `1` | Seconds between samples, 1–60. |
| `process-interval` | `5` | Seconds between top-process snapshots, 0–300 (`0` disables). |
| `docker` | `true` | Collect per-container CPU, memory, I/O and OOM stats from Docker cgroups. |
| `github-token` | `${{ github.token }}` | Used once, in the post step, to read step timings. Needs `actions: read`. |
| `artifact-name` | `''` | Empty means auto-generated: `ci-telemetry-<job>-<attempt>-<hash>`. |
| `retention-days` | `7` | Artifact retention in days, 1–90. |
| `job-summary` | `true` | Write a per-step table and findings to the job summary. |
| `html-report` | `true` | Include a self-contained `report.html` in the artifact. |

Invalid values fall back to the default and produce a warning; they never fail the job.

## What's collected

| Group | Fields | Source | Cadence |
|---|---|---|---|
| CPU | `usr`, `sys`, `iow`, `steal` (% of all CPUs on the host) | `/proc/stat` | every tick |
| Load | `load1` | `/proc/loadavg` | every tick |
| Memory | `used`, `avail`, `cached`, `swap` (bytes) | `/proc/meminfo` | every tick |
| Pressure | `cpu_some`, `mem_some`, `mem_full`, `io_some`, `io_full` (avg10 %) | `/proc/pressure/*` | every tick |
| Disk I/O | `rd`, `wr` (bytes/s, whole disks only, no partitions or loop devices) | `/proc/diskstats` | every tick |
| Network | `rx`, `tx` (bytes/s, excluding `lo`) | `/proc/net/dev` | every tick |
| Filesystem | free bytes on `/` and on `$GITHUB_WORKSPACE` | `statvfs` | every 10 s |
| Processes | top 5 by CPU% and top 5 by RSS: `pid`, `comm`, `cpu`, `rss` | `/proc/[pid]/stat` (CPU times; RSS from field 24) | `--proc-interval` (default 5 s) |
| Containers | `id`, `cpu`, `mem`, `mem_peak`, `io_rd`, `io_wr`, `oom_kills` | cgroup v2 `docker-<id>.scope/{cpu.stat,memory.current,memory.peak,memory.events,io.stat}` | every 2 s |

CPU percentages use two different units, both per the standard Linux convention: **host** CPU (`usr`/`sys`/`iow`/`steal` above) is a percentage of *all* CPUs combined, while **process** and **container** CPU (top-process snapshots, container `cpu`) are each a percentage of *one* core, so a two-thread process on a 4-core runner can read up to 200%.

## Artifact contents

- `samples.ndjson` — the raw collector output, one JSON record per line.
- `report.json` — the aggregated report (job/runner info, capabilities, per-step and per-container stats, OOM events, findings, collector overhead). Validates against [`schema/report.schema.json`](schema/report.schema.json).
- `report.html` — a self-contained report (inline CSS and SVG, no external resources or scripts) with time-series charts, step/container tables and findings, when `html-report` is enabled.

## Overhead

The collector is built to stay out of the way: on a 5-minute workload the budget is **peak RSS ≤ 5 MB** and **average CPU ≤ 0.5% of one core**, enforced in this repository's own end-to-end tests. It runs at `nice 19` and sets `/proc/self/oom_score_adj` to `1000`, so it is the first thing the kernel deprioritizes for CPU, and under memory pressure the kernel prefers to kill the collector before your job's processes. Each report's `collector` block (`peak_rss`, `cpu_seconds`, `avg_cpu_pct`, `end_reason`) records the actual figures measured for that specific run.

## Permissions and graceful degradation

- **`actions: read`** — needed for the `github-token` to fetch step timings from the Actions API. Without it, `report.json` has `steps: null` and a `steps_error`, and the job summary and HTML report show step-less aggregate charts instead of a per-step table. The job never fails because of this.
- **Passwordless `sudo`** — used to run `sudo -n dmesg --time-format iso` for kernel-level OOM detection. Without it, `capabilities.dmesg` is `false` and kernel OOM kills are not reported (container OOM kills, detected from cgroup counters, are unaffected).
- **The Docker socket** (`/var/run/docker.sock`) — used to look up each container's name and image. Without it, `capabilities.docker_socket` is `false` and containers appear under their 12-character short ID instead of their name.

Every other missing source (no PSI, cgroup v1 instead of v2, and so on) is recorded once in `capabilities` and skipped; the collector and the action never exit because of a missing source.

## Limitations

- **Container jobs (`container:`):** `main`, `post` and the collector run inside the job container. `/proc/stat` and `/proc/meminfo` still show the VM's totals, which is useful. Sibling containers' cgroups and the Docker socket are usually not visible, so per-container stats and name lookups are unavailable (recorded in `capabilities`). `dmesg` is normally unavailable too.
- Step boundaries have 1-second resolution (API limit).
- Metrics start when the action's step runs. Work done in steps before it is not sampled.
- **Container OOM timing:** Docker removes a container's cgroup the moment it exits. The collector samples containers every 2 s, so a container whose *main process* is OOM-killed usually disappears before its `oom_kill` counter is read — the kernel `dmesg` event (source `kernel`) is the reliable signal in that case. A container OOM is reported reliably via the `container` source only when a non-PID-1 process inside it is killed and the container keeps running.
- **OOM detection** recognises modern kernel messages ("Killed process …"); the wording of very old kernels isn't parsed.
- **Linux only.** Any other OS or architecture is a no-op (one `core.notice`, no telemetry, no failure).
- **GitHub Enterprise Server is not supported** (the `@actions/artifact` v2 client used to upload the report does not support GHES).

## Verifying the binaries

Each release's `dist/bin/*` binaries are published with build provenance attestations. Verify one with:

```bash
gh attestation verify dist/bin/collector-linux-x64 --repo <owner>/ci-telemetry
```

## Development

```bash
npm ci && npm test
(cd collector && cargo test)
npm run build
```

`dist/main` and `dist/post` (the bundled JavaScript that `runs.using: node24` executes) are committed, so any change under `src/` must be followed by `npm run build` and the resulting `dist/` changes committed too; CI fails if they are stale. The collector binaries in `dist/bin` are **not** committed on `main`: the release workflow builds them and commits them only onto the tag-only release commit.

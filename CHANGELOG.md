# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- First release of the ci-telemetry action. It's a single `uses:` step with an automatic `post` step.
- Rust collector (static musl, x64 and arm64) that samples CPU, load, memory, PSI, disk, network, filesystem free space, top processes and Docker cgroups into NDJSON. It runs at `nice 19` with `oom_score_adj 1000`, has a `Runner.Worker` watchdog, and downsamples once it passes 50 MiB of data.
- Per-step breakdown from the Actions jobs API, with graceful fallback when `actions: read` is missing.
- OOM detection from `dmesg`, container cgroup counters and collector death.
- Findings for memory-starved, CPU-bound and I/O-bound steps, CPU steal, a nearly full disk and swapping.
- `report.json` (JSON Schema, `schema_version: 1`), a self-contained `report.html`, and a job summary.
- CI, end-to-end scenario workflows, and a release workflow with build-provenance attestations.

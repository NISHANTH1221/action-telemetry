# Contributing to ci-telemetry

Thanks for helping. This guide covers everything from a first local build to getting a PR merged.

<details>
<summary><strong>Contents</strong></summary>

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Repository layout](#repository-layout)
- [Building and testing](#building-and-testing)
- [Testing on Linux from macOS or Windows](#testing-on-linux-from-macos-or-windows)
- [Design rules you must keep](#design-rules-you-must-keep)
- [Adding a new metric](#adding-a-new-metric)
- [Commit messages](#commit-messages)
- [Pull request checklist](#pull-request-checklist)
- [Releases (maintainers)](#releases-maintainers)

</details>

## Ways to contribute

- **Report a bug.** Use the bug template and attach the run's `report.json`; its `capabilities` block shows what was available on that runner.
- **Suggest a feature.** Describe the question about your CI you wanted the report to answer, not only the metric.
- **Improve docs.** README fixes, self-hosted setups you've verified, and troubleshooting entries are all welcome.
- **Write code.** Issues labelled `good first issue` and `help wanted` are a good place to start. For anything large, open an issue first so we can agree on the approach before you invest time.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

| Tool | Version | Why |
|---|---|---|
| Node.js | 24 (matches `runs.using: node24`) | Build and test the action |
| npm | bundled with Node | Dependencies |
| Rust | stable, with `rustfmt` and `clippy` | The collector |
| Docker | optional | Run Linux tests from macOS or Windows |

```bash
git clone https://github.com/NISHANTH1221/action-telemetry.git
cd action-telemetry
npm ci
(cd collector && cargo build)
```

## Repository layout

```
action.yml                 Marketplace metadata: inputs, node24 main/post
src/                       TypeScript action
  main.ts / post.ts          testable orchestration (runMain / runPost)
  entry/                     thin ncc entry points that wire in the real dependencies
  collector-control.ts       spawn and stop the collector
  samples.ts                 tolerant NDJSON parsing
  steps.ts                   step timings from the Actions API
  oom.ts                     dmesg, container and collector OOM detection
  aggregate.ts findings.ts   figures for each step, container and job, plus threshold rules
  report.ts                  report.json assembly
  render/summary.ts html.ts  job summary and the self-contained HTML report
  upload.ts                  artifact naming and upload with conflict retry
test/                      Vitest suites (one per src module) + fixtures.ts
collector/                 Rust collector (library `telemetry` + binary `collector`)
  src/sources/*.rs           one file per /proc or cgroup source
  src/run.rs                 the tick loop
  tests/fixtures/linux/      procfs and sysfs fixture trees
schema/report.schema.json  JSON Schema for report.json
dist/main, dist/post       committed ncc bundles (what GitHub runs)
scripts/verify-e2e.mjs     assertions for the end-to-end workflow
.github/workflows/         ci.yml, e2e.yml, release.yml
docs/superpowers/          design spec and implementation plan
```

The NDJSON file written by the collector is the **only** interface between Rust and TypeScript. When you change the record format, update both `collector/src/record.rs` and `src/types.ts` in the same PR.

## Building and testing

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest
npm run build              # ncc → dist/main, dist/post

cd collector
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

> [!IMPORTANT]
> **Commit `dist/`.** GitHub runs the committed `dist/main/index.js` and `dist/post/index.js`, not `src/`. After any change under `src/` or to dependencies, run `npm run build` and commit the result. CI fails if `dist/` is stale. The collector binaries (`dist/bin/`) are **never** committed on branches; the release workflow builds them.

Guidelines for tests:

- Follow TDD: write the failing test first.
- TypeScript modules take their side effects (process, fs, API) as injected dependencies, so tests use small fakes instead of mocking modules.
- Rust parsers are pure functions over `&str`, tested against real-looking fixtures under `collector/tests/fixtures/linux/`. Rust tests must pass on **macOS and Linux**, so put Linux-only calls behind `#[cfg(target_os = "linux")]`.
- Test output should be clean, with no warnings or stray logs.

## Testing on Linux from macOS or Windows

`/proc` only exists on Linux. Run the collector's tests and a smoke run in a container:

```bash
docker run --rm -v "$PWD/collector":/w:ro rust:1 bash -c '
  cp -r /w /src && cd /src && export CARGO_TARGET_DIR=/tmp/target
  cargo test
  cargo build --release
  /tmp/target/release/collector --out /tmp/s.ndjson --interval 1 --watch-pid $$ & P=$!
  sleep 4; kill -TERM $P; wait $P
  head -n2 /tmp/s.ndjson; tail -n1 /tmp/s.ndjson'
```

You should see a `meta` record, some `sample` records, and an `end` record with `"reason":"sigterm"` whose `self.peak_rss` is well under 5 MB.

To exercise the whole action on real runners, push a branch to your fork. The `e2e` workflow runs every scenario (a normal job on x64 and arm64, a failing step, a host OOM, a container OOM, a service container, a token without `actions: read`, and the overhead budget), and its `verify` job checks every artifact against the schema.

## Design rules you must keep

These are the promises the action makes to its users. A PR that breaks one won't be merged.

1. **Never fail the user's job.** Every error in `main` and `post` becomes `core.warning`. Nothing may call `core.setFailed`, throw out of an entry point, or exit non-zero.
2. **No network while the user's steps run.** The collector talks only to local files and the local Docker socket. Network calls belong in `post`.
3. **Stay within the overhead budget:** peak RSS ≤ 5 MB and average CPU ≤ 0.5 % of one core. The collector spawns no child processes, and new sources must be cheap to read at 1 Hz.
4. **Degrade, don't break.** Record a missing source in `capabilities` and carry on.
5. **Keep `report.json` backward compatible** within a major version. Adding fields is fine; renaming or removing them needs a new `schema_version` and a major release.

## Adding a new metric

Most metric PRs touch the same chain of files:

1. `collector/src/sources/<name>.rs`: a pure parser, a reader, and fixture-backed tests.
2. `collector/src/record.rs`: the new field. Use `Option` plus `skip_serializing_if` when it isn't collected on every tick.
3. `collector/src/run.rs`: sample it at a sensible cadence.
4. `src/types.ts`: the matching TypeScript type.
5. `src/aggregate.ts` and `src/report.ts`: summarise it for each step or for the job, if that's useful.
6. `schema/report.schema.json`: describe any new report fields.
7. `src/render/html.ts` and `src/render/summary.ts`: show it, if it's worth a user's attention.
8. `README.md` → *What's collected*.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org):

```
feat(collector): add per-cgroup network counters
fix(action): keep the summary when report.json can't be written
docs: document ARC runners
ci: pin the rust toolchain
```

Scopes in use: `collector`, `action`, `ci`, `docs`, `release`. Breaking changes carry `!` (e.g. `feat(action)!:`) and a `BREAKING CHANGE:` footer.

## Pull request checklist

- [ ] An issue exists for anything non-trivial, and the PR links it.
- [ ] Tests were added or updated and fail without the change.
- [ ] `npm run typecheck && npm test` pass.
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` pass, if the collector changed.
- [ ] `npm run build` was run and the `dist/` changes are committed, if `src/` or dependencies changed.
- [ ] The design rules above still hold.
- [ ] README, schema and CHANGELOG (under *Unreleased*) are updated where users will notice.

A maintainer reviews every PR; CI and e2e must be green before merge.

## Releases (maintainers)

1. Move the *Unreleased* notes in `CHANGELOG.md` under the new version and merge that to the default branch.
2. Run the **release** workflow (`Actions → release → Run workflow`) with the version `X.Y.Z`.
3. The workflow cross-compiles the collector for x64 and arm64 (static musl), attests the binaries, commits them onto a **tag-only** commit, pushes `vX.Y.Z`, moves the `vX` major tag, and creates the GitHub release.
4. Publish or refresh the Marketplace listing from the new release.

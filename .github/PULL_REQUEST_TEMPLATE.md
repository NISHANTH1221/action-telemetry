## What & why

<!-- What does this change, and which issue does it address? Closes #… -->

## How it was tested

<!-- Commands run, new/updated tests, e2e run link if relevant. -->

## Checklist

- [ ] Tests added/updated and they fail without the change
- [ ] `npm run typecheck && npm test` pass
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` pass (if `collector/` changed)
- [ ] `npm run build` run and `dist/` changes committed (if `src/` or dependencies changed)
- [ ] Design rules in CONTRIBUTING.md still hold (never fail the job, no network during steps, overhead budget, graceful degradation, report.json compatibility)
- [ ] README / schema / CHANGELOG (*Unreleased*) updated where user-visible

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

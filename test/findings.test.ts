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

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

describe('stale in-progress steps', () => {
  const stale: StepTiming[] = [
    { name: 'A', number: 1, conclusion: null, started_at: T0, completed_at: null },
    { name: 'B', number: 2, conclusion: null, started_at: T0 + 3, completed_at: null },
  ];
  it('ends an in-progress step where the next started step begins', () => {
    const stats = aggregateSteps(parsed({ samples: [makeSample(T0 + 1), makeSample(T0 + 4)] }), stale);
    expect(stats.map((s) => [s.name, s.samples, s.duration_s])).toEqual([['A', 1, 3], ['B', 1, 1]]);
    expect(stepAt(T0 + 4, stale)?.name).toBe('B');
    expect(stepAt(T0 + 1, stale)?.name).toBe('A');
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

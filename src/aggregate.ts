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
/** When step i stops owning samples: its completion, or the next step's start if earlier (stale in-progress data). */
function effectiveEnd(steps: StepTiming[], i: number): number {
  return Math.min(steps[i].completed_at ?? Infinity, steps[i + 1]?.started_at ?? Infinity);
}
const inStep = (t: number, steps: StepTiming[], i: number) => t >= steps[i].started_at && t < effectiveEnd(steps, i);

export function stepAt(t: number, steps: StepTiming[]): StepTiming | null {
  return steps.find((_, i) => inStep(t, steps, i)) ?? null;
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
  return steps.map((step, n) => {
    const idx = p.samples.flatMap((s, i) => (inStep(s.t, steps, n) ? [i] : []));
    const ss = idx.map((i) => p.samples[i]);
    const ds = idx.map((i) => dts[i]);
    const eff = effectiveEnd(steps, n);
    const end = Number.isFinite(eff) ? eff : lastT ?? step.started_at;
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

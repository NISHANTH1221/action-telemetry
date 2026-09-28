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

/**
 * The collector has oom_score_adj 1000: if it vanished before post, memory most likely ran out.
 * With the kernel log available (`kernel` not null) only a logged OOM kill of `collectorPid` counts.
 */
export function collectorOomEvent(
  p: ParsedSamples,
  stop: StopResult | 'not-started',
  kernel: OomEvent[] | null = null,
  collectorPid: number | null = null,
): OomEvent[] {
  if (stop !== 'not-running' || p.end !== null) return [];
  if (kernel !== null) {
    const kill = kernel.find((e) => collectorPid !== null && e.pid === collectorPid);
    return kill ? [{ t: kill.t, process: 'ci-telemetry collector', pid: collectorPid, source: 'collector', step: null }] : [];
  }
  if (p.samples.length === 0) return [];
  return [{ t: p.samples[p.samples.length - 1].t, process: 'ci-telemetry collector', pid: null, source: 'collector', step: null }];
}

import { JobTotals, StepStats } from './aggregate';
import { formatBytes, iso } from './format';
import { OomEvent } from './oom';

export interface Finding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  step: string | null;
}

export const THRESHOLDS = {
  minStepSeconds: 30,
  memFullPct: 10,
  cpuBusyPct: 90,
  ioFullPct: 20,
  stealPct: 5,
  minFreeBytes: 1024 ** 3,
} as const;

function oomMessage(e: OomEvent): string {
  const where = e.step ? ` during step "${e.step}"` : '';
  if (e.source === 'collector') {
    // pid is set only when the kernel log confirmed the kill.
    const how = e.pid !== null ? 'was OOM-killed' : 'was terminated early';
    const hint = e.pid !== null ? '' : ' (most likely OOM-killed)';
    return `The telemetry collector ${how} at ${iso(e.t)}${where}${hint}; later data is missing`;
  }
  if (e.source === 'container') return `Container ${e.process} was OOM-killed${where}`;
  return `OOM kill of ${e.process} (pid ${e.pid})${where}`;
}

export function computeFindings(i: { steps: StepStats[] | null; totals: JobTotals; oom: OomEvent[] }): Finding[] {
  const out: Finding[] = i.oom.map((e) => ({ level: 'error', code: 'oom', message: oomMessage(e), step: e.step }));
  const warn = (code: string, message: string, step: string | null = null) => out.push({ level: 'warning', code, message, step });

  for (const s of i.steps ?? []) {
    if (s.duration_s < THRESHOLDS.minStepSeconds || s.samples === 0) continue;
    const memFull = s.psi_max?.mem_full ?? 0;
    const ioFull = s.psi_max?.io_full ?? 0;
    if (memFull >= THRESHOLDS.memFullPct) {
      warn('memory-starved', `Step "${s.name}" was memory-starved (memory pressure peaked at ${memFull.toFixed(1)}%); the runner is probably undersized`, s.name);
    }
    if ((s.cpu_avg ?? 0) >= THRESHOLDS.cpuBusyPct) {
      warn('cpu-bound', `Step "${s.name}" was CPU-bound (average CPU ${(s.cpu_avg ?? 0).toFixed(1)}%)`, s.name);
    }
    if (ioFull >= THRESHOLDS.ioFullPct) {
      warn('io-bound', `Step "${s.name}" was I/O-bound (I/O pressure peaked at ${ioFull.toFixed(1)}%)`, s.name);
    }
  }

  const t = i.totals;
  if ((t.steal_avg ?? 0) >= THRESHOLDS.stealPct) {
    warn('steal', `CPU steal averaged ${(t.steal_avg ?? 0).toFixed(1)}%: the host is contended (noisy neighbour)`);
  }
  const frees = [t.min_root_free, t.min_ws_free].filter((v): v is number => v !== null);
  if (frees.length && Math.min(...frees) < THRESHOLDS.minFreeBytes) {
    warn('disk-full', `Disk nearly full: only ${formatBytes(Math.min(...frees))} free at the lowest point`);
  }
  if (t.swap_start !== null && t.swap_max !== null && t.swap_max > t.swap_start) {
    warn('swap', `The runner started swapping (swap use grew by ${formatBytes(t.swap_max - t.swap_start)})`);
  }
  return out;
}

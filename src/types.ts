export interface CpuPct { usr: number; sys: number; iow: number; steal: number }
export interface Mem { used: number; avail: number; cached: number; swap: number }
export interface Psi {
  cpu_some: number | null;
  mem_some: number | null;
  mem_full: number | null;
  io_some: number | null;
  io_full: number | null;
}
export interface ProcEntry { pid: number; comm: string; cpu: number; rss: number }
export interface Ctr {
  id: string;
  cpu: number;
  mem: number;
  mem_peak: number | null;
  io_rd: number;
  io_wr: number;
  oom_kills: number;
}

export interface Sample {
  type: 'sample';
  t: number;
  cpu: CpuPct;
  load1: number;
  mem: Mem;
  psi?: Psi;
  disk: { rd: number; wr: number };
  net: { rx: number; tx: number };
  fs?: { root_free: number | null; ws_free: number | null };
  procs?: { cpu: ProcEntry[]; rss: ProcEntry[] };
  ctr?: Ctr[];
}

export interface Meta {
  type: 'meta';
  v: number;
  t: number;
  interval: number;
  cpus: number;
  mem_total: number;
  kernel: string;
  arch: string;
  cgroup: string;
  capabilities: { psi: boolean; docker_cgroups: boolean; docker_socket: boolean };
}

export interface ContainerRecord { type: 'container'; t: number; id: string; name: string; image: string }
export interface Downsample { type: 'downsample'; t: number; interval: number }
export interface End {
  type: 'end';
  t: number;
  reason: string;
  self: { peak_rss: number; cpu_seconds: number };
}

export interface ParsedSamples {
  meta: Meta | null;
  samples: Sample[];
  containers: Map<string, { name: string; image: string }>;
  downsamples: Downsample[];
  end: End | null;
  invalidLines: number;
}

/** A job step with epoch-second timestamps. completed_at is null while in progress. */
export interface StepTiming {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: number;
  completed_at: number | null;
}

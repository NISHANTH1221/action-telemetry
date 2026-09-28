import { End, Meta, ParsedSamples, Sample } from '../src/types';

export const T0 = 1_759_050_000;

export const META: Meta = {
  type: 'meta', v: 1, t: T0, interval: 1, cpus: 2, mem_total: 8_000_000_000,
  kernel: '6.8.0-1015-azure', arch: 'x86_64', cgroup: 'v2',
  capabilities: { psi: true, docker_cgroups: true, docker_socket: true },
};

export function makeSample(t: number, o: Partial<Sample> = {}): Sample {
  return {
    type: 'sample', t,
    cpu: { usr: 10, sys: 5, iow: 0, steal: 0 },
    load1: 0.5,
    mem: { used: 1_000_000_000, avail: 7_000_000_000, cached: 500_000_000, swap: 0 },
    psi: { cpu_some: 1, mem_some: 0, mem_full: 0, io_some: 0, io_full: 0 },
    disk: { rd: 0, wr: 0 },
    net: { rx: 0, tx: 0 },
    ...o,
  };
}

export function makeEnd(t: number): End {
  return { type: 'end', t, reason: 'sigterm', self: { peak_rss: 1_800_000, cpu_seconds: 0.03 } };
}

export function parsed(o: Partial<ParsedSamples> = {}): ParsedSamples {
  return { meta: META, samples: [], containers: new Map(), downsamples: [], end: null, invalidLines: 0, ...o };
}

export function ndjson(records: any[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

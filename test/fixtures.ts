import { buildReport, Report } from '../src/report';
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

export function ndjson(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function makeReport(): { report: Report; samples: Sample[] } {
  const ctrId = 'c'.repeat(64);
  const samples = [0, 1, 2, 3, 4].map((i) =>
    makeSample(T0 + 1 + i, {
      cpu: { usr: 50, sys: 10, iow: 1, steal: 0 },
      disk: { rd: 1024 * i, wr: 2048 },
      net: { rx: 4096, tx: 512 },
      ctr: [{ id: ctrId, cpu: 20, mem: 100_000_000 + i, mem_peak: 120_000_000, io_rd: 0, io_wr: 0, oom_kills: 0 }],
    }),
  );
  const p = parsed({ samples, containers: new Map([[ctrId, { name: 'db', image: 'postgres:16' }]]), end: makeEnd(T0 + 6) });
  const report = buildReport({
    parsed: p,
    steps: {
      steps: [
        { name: 'Set up job', number: 1, conclusion: 'success', started_at: T0 - 10, completed_at: T0 - 5 },
        { name: 'Build | test', number: 2, conclusion: 'success', started_at: T0, completed_at: T0 + 3 },
        { name: 'Post ci-telemetry', number: 3, conclusion: null, started_at: T0 + 3, completed_at: null },
      ],
      jobName: 'build',
      jobUrl: 'https://github.com/o/r/actions/runs/1/job/2',
    },
    dmesg: null,
    stopResult: 'stopped',
    env: {
      GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'build', GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'abc123', GITHUB_REF: 'refs/heads/main', RUNNER_NAME: 'GitHub Actions 1',
    },
    now: T0 + 6,
  });
  return { report, samples };
}

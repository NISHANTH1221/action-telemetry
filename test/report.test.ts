import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import schema from '../schema/report.schema.json';
import { buildReport } from '../src/report';
import { makeEnd, makeReport, makeSample, parsed, T0 } from './fixtures';

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe('buildReport', () => {
  it('produces a schema-valid report with steps, containers and collector overhead', () => {
    const { report } = makeReport();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.job).toMatchObject({ repository: 'o/r', job: 'build', job_name: 'build' });
    expect(report.runner).toMatchObject({ cpus: 2, mem_total: 8_000_000_000, os: 'Linux', arch: 'x86_64' });
    expect(report.steps?.map((s) => s.name)).toEqual(['Set up job', 'Build | test', 'Post ci-telemetry']);
    expect(report.containers[0]).toMatchObject({ name: 'db', image: 'postgres:16' });
    expect(report.collector).toEqual({ peak_rss: 1_800_000, cpu_seconds: 0.03, avg_cpu_pct: 0.5, end_reason: 'sigterm', invalid_lines: 0 });
    expect(report.capabilities).toEqual({ psi: true, docker_cgroups: true, docker_socket: true, steps_api: true, dmesg: false });
  });

  it('stays schema-valid with no steps, no meta and a dead collector', () => {
    const r = buildReport({
      parsed: parsed({ meta: null, samples: [makeSample(T0 + 1)] }),
      steps: { steps: null, error: 'GitHub API returned 403' },
      dmesg: `${new Date((T0 + 1) * 1000).toISOString().replace('.000Z', ',0+00:00')} Out of memory: Killed process 9 (cc1plus)`,
      stopResult: 'not-running',
      env: {},
      now: T0 + 10,
    });
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
    expect(r.steps).toBeNull();
    expect(r.steps_error).toBe('GitHub API returned 403');
    expect(r.collector.end_reason).toBe('missing');
    expect(r.oom_events.map((e) => e.source)).toEqual(['kernel', 'collector']);
    expect(r.findings.filter((f) => f.code === 'oom')).toHaveLength(2);
  });

  it('assigns OOM events to steps', () => {
    const r = buildReport({
      parsed: parsed({ samples: [makeSample(T0 + 1)], end: makeEnd(T0 + 2) }),
      steps: { steps: [{ name: 'Build', number: 1, conclusion: 'failure', started_at: T0, completed_at: T0 + 5 }] },
      dmesg: `${new Date((T0 + 1) * 1000).toISOString().replace('.000Z', ',0+00:00')} Out of memory: Killed process 9 (cc1plus)`,
      stopResult: 'stopped', env: {}, now: T0 + 10,
    });
    expect(r.oom_events[0].step).toBe('Build');
  });

  it('rejects a report missing a required key', () => {
    const { report } = makeReport();
    const { steps: _omit, ...broken } = report;
    expect(validate(broken)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { Inputs } from '../src/inputs';
import { PostDeps, runPost } from '../src/post';
import { makeEnd, makeSample, META, ndjson, T0 } from './fixtures';

const INPUTS: Inputs = { interval: 1, processInterval: 5, docker: true, githubToken: 't', artifactName: '', retentionDays: 7, jobSummary: true, htmlReport: true };
const SAMPLES = ndjson([META, makeSample(T0 + 1), makeSample(T0 + 2), makeEnd(T0 + 3)]);

function deps(o: Partial<PostDeps> = {}, state: Record<string, string> = { enabled: 'true', pid: '42', dataDir: '/d', dataFile: '/d/samples.ndjson', startedAt: String(T0) }) {
  const files: Record<string, string> = { '/d/samples.ndjson': SAMPLES };
  const log = { warnings: [] as string[], infos: [] as string[], summaries: [] as string[], uploads: [] as any[], stopped: [] as number[] };
  const d: PostDeps = {
    getState: (n) => state[n] ?? '',
    env: { GITHUB_JOB: 'build', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'r1', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' },
    inputs: INPUTS,
    stop: async (pid) => { log.stopped.push(pid); return 'stopped'; },
    readText: (f) => files[f] ?? null,
    writeText: (f, t) => { files[f] = t; },
    fetchSteps: async () => ({ steps: [{ name: 'Build', number: 1, conclusion: 'success', started_at: T0, completed_at: null }], jobName: 'build' }),
    readDmesg: async () => null,
    writeSummary: async (md) => { log.summaries.push(md); },
    upload: async (name, f, root, days) => { log.uploads.push({ name, files: f, root, days }); return { id: 123, name }; },
    warning: (m) => log.warnings.push(m),
    info: (m) => log.infos.push(m),
    now: () => T0 + 10,
    ...o,
  };
  return { d, files, log };
}

describe('runPost', () => {
  it('stops the collector, writes reports, summarises and uploads', async () => {
    const { d, files, log } = deps();
    await runPost(d);
    expect(log.stopped).toEqual([42]);
    const report = JSON.parse(files['/d/report.json']);
    expect(report.schema_version).toBe(1);
    expect(report.steps[0]).toMatchObject({ name: 'Build', samples: 2 });
    expect(files['/d/report.html']).toContain('<!doctype html>');
    expect(log.summaries[0]).toContain('## CI telemetry');
    expect(log.uploads[0].name).toMatch(/^ci-telemetry-build-1-[0-9a-f]{6}$/);
    expect(log.uploads[0].files).toEqual(['/d/report.json', '/d/samples.ndjson', '/d/report.html']);
    expect(log.uploads[0]).toMatchObject({ root: '/d', days: 7 });
    expect(log.infos.join('\n')).toContain('https://github.com/o/r/actions/runs/9/artifacts/123');
    expect(log.warnings).toEqual([]);
  });

  it('does nothing when main skipped an unsupported platform', async () => {
    const { d, log } = deps({}, { enabled: 'false' });
    await runPost(d);
    expect(log.stopped).toEqual([]);
    expect(log.summaries).toEqual([]);
    expect(log.uploads).toEqual([]);
  });

  it('writes an "unavailable" summary when main failed to start the collector', async () => {
    const { d, log } = deps({}, {});
    await runPost(d);
    expect(log.summaries[0]).toContain('Telemetry was unavailable for this job');
    expect(log.uploads).toEqual([]);
  });

  it('still uploads without a step breakdown when the API fails', async () => {
    const { d, files, log } = deps({ fetchSteps: async () => ({ steps: null, error: 'GitHub API returned 403' }) });
    await runPost(d);
    expect(JSON.parse(files['/d/report.json']).steps).toBeNull();
    expect(log.warnings[0]).toBe('ci-telemetry: per-step breakdown unavailable: GitHub API returned 403');
    expect(log.uploads).toHaveLength(1);
  });

  it('keeps the summary when upload fails', async () => {
    const { d, log } = deps({ upload: async () => { throw new Error('network down'); } });
    await runPost(d);
    expect(log.summaries).toHaveLength(1);
    expect(log.warnings).toEqual(['ci-telemetry: artifact upload failed: network down']);
  });

  it('respects job-summary/html-report inputs and sanitizes a custom name', async () => {
    const { d, log } = deps({ inputs: { ...INPUTS, jobSummary: false, htmlReport: false, artifactName: 'my/tele:metry' } });
    await runPost(d);
    expect(log.summaries).toEqual([]);
    expect(log.uploads[0].name).toBe('my-tele-metry');
    expect(log.uploads[0].files).toEqual(['/d/report.json', '/d/samples.ndjson']);
  });

  it('still summarises and uploads when report.json cannot be written', async () => {
    const { d, files, log } = deps();
    d.writeText = (f, t) => { if (f.endsWith('report.json')) throw new Error('ENOSPC'); files[f] = t; };
    await runPost(d);
    expect(log.warnings).toEqual(['ci-telemetry: could not write report.json: ENOSPC']);
    expect(log.summaries[0]).toContain('## CI telemetry');
    expect(log.uploads[0].files).toEqual(['/d/samples.ndjson', '/d/report.html']);
  });

  it('attributes a kernel OOM kill of the saved collector pid to the collector only', async () => {
    const line = `${new Date((T0 + 2) * 1000).toISOString().replace('.000Z', ',0+00:00')} Out of memory: Killed process 42 (collector-linux)`;
    const { d, files } = deps({ stop: async () => 'not-running', readDmesg: async () => line, readText: (f) => (f === '/d/samples.ndjson' ? ndjson([META, makeSample(T0 + 1)]) : null) });
    await runPost(d);
    expect(JSON.parse(files['/d/report.json']).oom_events.map((e: any) => [e.source, e.pid])).toEqual([['collector', 42]]);
  });

  it('never rejects, even if a dependency throws unexpectedly', async () => {
    const { d, log } = deps({ readText: () => { throw new Error('EIO'); }, fetchSteps: () => Promise.reject(new Error('boom')) });
    await expect(runPost(d)).resolves.toBeUndefined();
    expect(log.warnings.join('\n')).toContain('EIO');
  });
});

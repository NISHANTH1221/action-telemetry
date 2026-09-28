import { describe, expect, it } from 'vitest';
import { MainDeps, runMain } from '../src/main';
import { StartOptions } from '../src/collector-control';

function deps(o: Partial<MainDeps> = {}) {
  const state: Record<string, string> = {};
  const log = { notices: [] as string[], warnings: [] as string[], infos: [] as string[], starts: [] as StartOptions[] };
  const d: MainDeps = {
    platform: 'linux', arch: 'x64', pid: 100, binDir: '/a/dist/bin',
    env: { RUNNER_TEMP: '/rt', GITHUB_WORKSPACE: '/ws' },
    readInputs: () => ({ interval: 1, processInterval: 5, docker: true, githubToken: 't', artifactName: '', retentionDays: 7, jobSummary: true, htmlReport: true }),
    findWorker: () => 80,
    start: (s) => { log.starts.push(s); return { pid: 555, dataDir: '/rt/ci-telemetry/ab', dataFile: '/rt/ci-telemetry/ab/samples.ndjson' }; },
    saveState: (k, v) => { state[k] = v; },
    notice: (m) => log.notices.push(m), warning: (m) => log.warnings.push(m), info: (m) => log.infos.push(m),
    now: () => 1000,
    ...o,
  };
  return { d, state, log };
}

describe('runMain', () => {
  it('starts the collector and records state', () => {
    const { d, state, log } = deps();
    runMain(d);
    expect(log.starts[0]).toEqual({ binPath: '/a/dist/bin/collector-linux-x64', runnerTemp: '/rt', interval: 1, processInterval: 5, docker: true, watchPid: 80, workspace: '/ws' });
    expect(state).toEqual({ pid: '555', dataDir: '/rt/ci-telemetry/ab', dataFile: '/rt/ci-telemetry/ab/samples.ndjson', startedAt: '1000', enabled: 'true' });
    expect(log.warnings).toEqual([]);
  });

  it('no-ops with a notice on unsupported platforms', () => {
    const { d, state, log } = deps({ platform: 'darwin', arch: 'arm64' });
    runMain(d);
    expect(state).toEqual({ enabled: 'false' });
    expect(log.notices[0]).toContain('not supported on darwin/arm64');
    expect(log.starts).toEqual([]);
  });

  it('passes a null watch pid through in container jobs', () => {
    const { d, log } = deps({ findWorker: () => null });
    runMain(d);
    expect(log.starts[0].watchPid).toBeNull();
    expect(log.infos[0]).toContain('Runner.Worker is not visible');
  });

  it('turns start failures into a warning and leaves enabled unset', () => {
    const { d, state, log } = deps({ start: () => { throw new Error('failed to start collector at /x'); } });
    expect(() => runMain(d)).not.toThrow();
    expect(state.enabled).toBeUndefined();
    expect(log.warnings[0]).toBe('ci-telemetry: could not start telemetry: failed to start collector at /x');
  });
});

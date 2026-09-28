import * as os from 'node:os';
import * as path from 'node:path';
import type { StartOptions, StartResult } from './collector-control';
import type { Inputs } from './inputs';
import { collectorBinaryName } from './runner';

export interface MainDeps {
  platform: string;
  arch: string;
  pid: number;
  binDir: string;
  env: Record<string, string | undefined>;
  readInputs(): Inputs;
  findWorker(pid: number): number | null;
  start(o: StartOptions): StartResult;
  saveState(name: string, value: string): void;
  notice(msg: string): void;
  warning(msg: string): void;
  info(msg: string): void;
  now(): number;
}

/** Never throws: telemetry must not fail the user's job. */
export function runMain(d: MainDeps): void {
  try {
    const bin = collectorBinaryName(d.platform, d.arch);
    if (!bin) {
      d.saveState('enabled', 'false');
      d.notice(`ci-telemetry: telemetry is not supported on ${d.platform}/${d.arch} yet; skipping.`);
      return;
    }
    const inputs = d.readInputs();
    const startedAt = d.now();
    const watchPid = d.findWorker(d.pid);
    if (watchPid === null) {
      d.info('ci-telemetry: Runner.Worker is not visible (container job?); the collector will run until the post step stops it.');
    }
    const res = d.start({
      binPath: path.join(d.binDir, bin),
      runnerTemp: d.env.RUNNER_TEMP || os.tmpdir(),
      interval: inputs.interval,
      processInterval: inputs.processInterval,
      docker: inputs.docker,
      watchPid,
      workspace: d.env.GITHUB_WORKSPACE,
    });
    d.saveState('pid', String(res.pid));
    d.saveState('dataDir', res.dataDir);
    d.saveState('dataFile', res.dataFile);
    d.saveState('startedAt', String(startedAt));
    d.saveState('enabled', 'true');
    d.info(`ci-telemetry: collector started (pid ${res.pid}), writing to ${res.dataFile}`);
  } catch (e) {
    d.warning(`ci-telemetry: could not start telemetry: ${(e as Error).message}`);
  }
}

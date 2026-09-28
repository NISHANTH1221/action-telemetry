import { ChildProcess, spawn as nodeSpawn, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StartOptions {
  binPath: string;
  runnerTemp: string;
  interval: number;
  processInterval: number;
  docker: boolean;
  watchPid: number | null;
  workspace?: string;
}

export interface StartResult { pid: number; dataDir: string; dataFile: string }
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export function collectorArgs(o: StartOptions, dataFile: string): string[] {
  const args = [
    '--out', dataFile,
    '--interval', String(o.interval),
    '--proc-interval', String(o.processInterval),
    '--docker', String(o.docker),
    '--watch-pid', String(o.watchPid ?? 0),
  ];
  if (o.workspace) args.push('--workspace', o.workspace);
  return args;
}

export function startCollector(o: StartOptions, spawnFn: SpawnFn = nodeSpawn): StartResult {
  // Unique per invocation so two uses of the action in one job never share a file.
  const dataDir = path.join(o.runnerTemp, 'ci-telemetry', randomBytes(4).toString('hex'));
  fs.mkdirSync(dataDir, { recursive: true });
  const dataFile = path.join(dataDir, 'samples.ndjson');
  try {
    fs.chmodSync(o.binPath, 0o755);
  } catch {
    // Read-only or missing: rely on the committed file mode; spawn reports the real error.
  }
  const child = spawnFn(o.binPath, collectorArgs(o, dataFile), { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // Without a listener an async spawn error would crash this step.
  });
  if (child.pid === undefined) throw new Error(`failed to start collector at ${o.binPath}`);
  child.unref();
  return { pid: child.pid, dataDir, dataFile };
}

export type StopResult = 'stopped' | 'killed' | 'not-running';

export interface ProcessOps {
  kill(pid: number, sig: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export const realProcessOps: ProcessOps = {
  kill: (pid, sig) => { process.kill(pid, sig); },
  isAlive: (pid) => {
    try {
      // A zombie (exited but unreaped, common in containers without an init) counts as gone.
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return s.charAt(s.lastIndexOf(')') + 2) !== 'Z';
    } catch {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function stopCollector(pid: number, ops: ProcessOps = realProcessOps, timeoutMs = 2000): Promise<StopResult> {
  if (!ops.isAlive(pid)) return 'not-running';
  try { ops.kill(pid, 'SIGTERM'); } catch { return 'not-running'; }
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    await ops.sleep(50);
    if (!ops.isAlive(pid)) return 'stopped';
  }
  try { ops.kill(pid, 'SIGKILL'); } catch { /* exited in the meantime */ }
  return 'killed';
}

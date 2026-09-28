import * as fs from 'node:fs';

export function collectorBinaryName(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform !== 'linux') return null;
  if (arch === 'x64') return 'collector-linux-x64';
  if (arch === 'arm64') return 'collector-linux-arm64';
  return null;
}

export interface ProcReader {
  comm(pid: number): string | null;
  ppid(pid: number): number | null;
}

export const procfsReader: ProcReader = {
  comm: (pid) => {
    try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
  },
  ppid: (pid) => {
    try {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const v = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
      return Number.isInteger(v) ? v : null;
    } catch {
      return null;
    }
  },
};

/**
 * The runner's per-job worker process. The collector exits when it disappears, so an
 * orphaned collector can't outlive its job on a persistent self-hosted runner.
 * Returns null when not visible (e.g. inside a `container:` job): the watchdog is then disabled.
 */
export function findRunnerWorkerPid(startPid: number, reader: ProcReader = procfsReader, maxDepth = 10): number | null {
  let pid: number | null = startPid;
  for (let i = 0; i < maxDepth && pid !== null && pid > 1; i++) {
    if (reader.comm(pid) === 'Runner.Worker') return pid;
    pid = reader.ppid(pid);
  }
  return null;
}

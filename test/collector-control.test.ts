import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectorArgs, ProcessOps, startCollector, StartOptions, stopCollector } from '../src/collector-control';

function fakeSpawn(pid: number | undefined) {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const fn: any = (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const child: any = new EventEmitter();
    child.pid = pid;
    child.unref = () => { child.unrefed = true; };
    setImmediate(() => { if (pid === undefined) child.emit('error', new Error('spawn ENOENT')); });
    return child;
  };
  return { fn, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
const opts = (runnerTemp: string, o: Partial<StartOptions> = {}): StartOptions => ({
  binPath: path.join(runnerTemp, 'no-such-collector'), runnerTemp, interval: 1, processInterval: 5,
  docker: true, watchPid: 77, workspace: '/ws', ...o,
});

describe('collectorArgs', () => {
  it('passes 0 when the worker pid is unknown (container jobs)', () => {
    const a = collectorArgs(opts('/t', { watchPid: null, workspace: undefined }), '/t/s.ndjson');
    expect(a).toEqual(['--out', '/t/s.ndjson', '--interval', '1', '--proc-interval', '5', '--docker', 'true', '--watch-pid', '0']);
  });
});

describe('startCollector', () => {
  it('spawns detached with ignored stdio and returns paths', () => {
    const rt = tmp();
    const { fn, calls } = fakeSpawn(4321);
    const r = startCollector(opts(rt), fn);
    expect(r.pid).toBe(4321);
    expect(r.dataDir).toMatch(new RegExp(`^${rt}/ci-telemetry/[0-9a-f]{8}$`));
    expect(fs.existsSync(r.dataDir)).toBe(true);
    expect(r.dataFile).toBe(path.join(r.dataDir, 'samples.ndjson'));
    expect(calls[0].opts).toEqual({ detached: true, stdio: 'ignore' });
    expect(calls[0].args).toContain('--workspace');
  });

  it('gives each invocation in the same job its own data dir', () => {
    const rt = tmp();
    const a = startCollector(opts(rt), fakeSpawn(1).fn);
    const b = startCollector(opts(rt), fakeSpawn(2).fn);
    expect(a.dataDir).not.toBe(b.dataDir);
  });

  it('makes the binary executable before spawning', () => {
    const rt = tmp();
    const bin = path.join(rt, 'collector');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 });
    startCollector(opts(rt, { binPath: bin }), fakeSpawn(5).fn);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  });

  it('throws (not crashes) when the process cannot be spawned', async () => {
    const rt = tmp();
    expect(() => startCollector(opts(rt), fakeSpawn(undefined).fn)).toThrow(/failed to start collector/);
    await new Promise((r) => setImmediate(r)); // the async 'error' event must have a listener
  });
});

describe('stopCollector', () => {
  function ops(aliveAfterSignals: number): ProcessOps & { signals: (string | number)[] } {
    const signals: (string | number)[] = [];
    return {
      signals,
      kill: (_pid, sig) => { signals.push(sig); },
      isAlive: () => signals.length < aliveAfterSignals || aliveAfterSignals === Infinity,
      sleep: async () => {},
    };
  }

  it('reports not-running when the process is gone', async () => {
    const o = ops(0);
    expect(await stopCollector(1, o)).toBe('not-running');
    expect(o.signals).toEqual([]);
  });

  it('stops with SIGTERM', async () => {
    const o = ops(1);
    expect(await stopCollector(1, o)).toBe('stopped');
    expect(o.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL after the timeout', async () => {
    const o = ops(Infinity);
    expect(await stopCollector(1, o, 200)).toBe('killed');
    expect(o.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

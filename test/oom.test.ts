import { describe, expect, it } from 'vitest';
import { collectorOomEvent, containerOomEvents, parseDmesg, parseDmesgTimestamp, readDmesg } from '../src/oom';
import { makeEnd, makeSample, parsed, T0 } from './fixtures';

const ID = 'c'.repeat(64);
const ctr = (oom: number) => [{ id: ID, cpu: 0, mem: 1, mem_peak: null, io_rd: 0, io_wr: 0, oom_kills: oom }];
const ts = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', ',123456+00:00');

describe('parseDmesgTimestamp', () => {
  it('parses util-linux iso format with comma fraction and offsets', () => {
    expect(parseDmesgTimestamp('2025-09-28T10:03:41,123456+00:00')).toBe(Date.parse('2025-09-28T10:03:41.123Z') / 1000);
    expect(parseDmesgTimestamp('2025-09-28T12:03:41,000000+0200')).toBe(Date.parse('2025-09-28T10:03:41Z') / 1000);
    expect(parseDmesgTimestamp('[  12.3]')).toBeNull();
  });
});

describe('parseDmesg', () => {
  it('extracts global and cgroup OOM kills inside the window', () => {
    const text = [
      `${ts(T0 - 100)} Out of memory: Killed process 11 (old) total-vm:1kB`,
      `${ts(T0 + 5)} oom-kill:constraint=CONSTRAINT_NONE,task=node,pid=22,uid=1001`,
      `${ts(T0 + 5)} Out of memory: Killed process 22 (node) total-vm:4096kB, anon-rss:2048kB`,
      `${ts(T0 + 9)} Memory cgroup out of memory: Killed process 33 (python3) total-vm:1kB`,
      `${ts(T0 + 9)} eth0: link up`,
    ].join('\n');
    const ev = parseDmesg(text, T0, T0 + 60);
    expect(ev.map((e) => [e.process, e.pid, e.source])).toEqual([['node', 22, 'kernel'], ['python3', 33, 'kernel']]);
    expect(ev[0].t).toBeCloseTo(T0 + 5.123, 3);
  });
});

describe('readDmesg', () => {
  it('returns stdout, or null when sudo/dmesg is unavailable', async () => {
    expect(await readDmesg(async () => ({ stdout: 'x' }))).toBe('x');
    expect(await readDmesg(async () => { throw new Error('sudo: a password is required'); })).toBeNull();
  });
});

describe('containerOomEvents', () => {
  it('emits one event per increase in a container kill count', () => {
    const samples = [makeSample(T0 + 1, { ctr: ctr(0) }), makeSample(T0 + 3, { ctr: ctr(1) }), makeSample(T0 + 5, { ctr: ctr(1) }), makeSample(T0 + 7, { ctr: ctr(2) })];
    const ev = containerOomEvents(samples, new Map([[ID, { name: 'db', image: 'postgres:16' }]]));
    expect(ev.map((e) => [e.t, e.process, e.source])).toEqual([[T0 + 3, 'db', 'container'], [T0 + 7, 'db', 'container']]);
  });
  it('falls back to the short id when the name is unknown', () => {
    expect(containerOomEvents([makeSample(T0, { ctr: ctr(1) })], new Map())[0].process).toBe('c'.repeat(12));
  });
});

describe('collectorOomEvent', () => {
  it('flags a collector that died before post stopped it', () => {
    const p = parsed({ samples: [makeSample(T0 + 1), makeSample(T0 + 2)] });
    expect(collectorOomEvent(p, 'not-running')).toEqual([{ t: T0 + 2, process: 'ci-telemetry collector', pid: null, source: 'collector', step: null }]);
  });
  it('does not flag a normal stop, a SIGKILL by post, or a collector that never started', () => {
    expect(collectorOomEvent(parsed({ samples: [makeSample(T0)], end: makeEnd(T0 + 1) }), 'stopped')).toEqual([]);
    expect(collectorOomEvent(parsed({ samples: [makeSample(T0)] }), 'killed')).toEqual([]);
    expect(collectorOomEvent(parsed(), 'not-running')).toEqual([]);
  });
});

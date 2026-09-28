import { describe, expect, it } from 'vitest';
import { collectorBinaryName, findRunnerWorkerPid, ProcReader } from '../src/runner';

function tree(nodes: Record<number, { comm: string; ppid: number }>): ProcReader {
  return { comm: (p) => nodes[p]?.comm ?? null, ppid: (p) => nodes[p]?.ppid ?? null };
}

describe('collectorBinaryName', () => {
  it('maps supported linux architectures', () => {
    expect(collectorBinaryName('linux', 'x64')).toBe('collector-linux-x64');
    expect(collectorBinaryName('linux', 'arm64')).toBe('collector-linux-arm64');
  });
  it('returns null for unsupported platforms', () => {
    expect(collectorBinaryName('darwin', 'arm64')).toBeNull();
    expect(collectorBinaryName('win32', 'x64')).toBeNull();
    expect(collectorBinaryName('linux', 'ia32')).toBeNull();
  });
});

describe('findRunnerWorkerPid', () => {
  it('walks up to Runner.Worker', () => {
    const r = tree({ 100: { comm: 'node', ppid: 90 }, 90: { comm: 'bash', ppid: 80 }, 80: { comm: 'Runner.Worker', ppid: 70 } });
    expect(findRunnerWorkerPid(100, r)).toBe(80);
  });
  it('returns null inside a container job where the worker is not visible', () => {
    const r = tree({ 12: { comm: 'node', ppid: 1 }, 1: { comm: 'tail', ppid: 0 } });
    expect(findRunnerWorkerPid(12, r)).toBeNull();
  });
  it('stops at maxDepth on a cycle', () => {
    const r = tree({ 5: { comm: 'a', ppid: 6 }, 6: { comm: 'b', ppid: 5 } });
    expect(findRunnerWorkerPid(5, r, 10)).toBeNull();
  });
});

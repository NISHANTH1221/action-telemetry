import { describe, expect, it } from 'vitest';
import { parseSamples } from '../src/samples';
import { makeEnd, makeSample, META, ndjson, T0 } from './fixtures';

describe('parseSamples', () => {
  it('splits records by type and sorts samples by time', () => {
    const text = ndjson([
      META,
      makeSample(T0 + 2),
      makeSample(T0 + 1),
      { type: 'container', t: T0 + 1, id: 'abc', name: 'db', image: 'postgres:16' },
      { type: 'downsample', t: T0 + 3, interval: 2 },
      makeEnd(T0 + 4),
    ]);
    const p = parseSamples(text);
    expect(p.meta?.cpus).toBe(2);
    expect(p.samples.map((s) => s.t)).toEqual([T0 + 1, T0 + 2]);
    expect(p.containers.get('abc')).toEqual({ name: 'db', image: 'postgres:16' });
    expect(p.downsamples).toHaveLength(1);
    expect(p.end?.reason).toBe('sigterm');
    expect(p.invalidLines).toBe(0);
  });

  it('skips a truncated last line from a killed collector', () => {
    const text = ndjson([META, makeSample(T0 + 1)]) + '{"type":"sample","t":1759050002,"cpu":{"us';
    const p = parseSamples(text);
    expect(p.samples).toHaveLength(1);
    expect(p.end).toBeNull();
    expect(p.invalidLines).toBe(1);
  });

  it('rejects well-formed JSON with the wrong shape', () => {
    const p = parseSamples(ndjson([{ type: 'sample', t: 1 }, { type: 'bogus', t: 1 }, [1, 2], null, 'x']));
    expect(p.samples).toEqual([]);
    expect(p.invalidLines).toBe(5);
  });

  it('handles an empty file', () => {
    const p = parseSamples('');
    expect(p.meta).toBeNull();
    expect(p.samples).toEqual([]);
  });

  it('rejects meta/end/container/downsample records with the wrong shape', () => {
    const p = parseSamples(
      ndjson([
        { type: 'meta', t: 1 },
        { type: 'end', t: 1, reason: 'sigterm' },
        { type: 'container', t: 1, id: 'x' },
        { type: 'downsample', t: 1 },
      ])
    );
    expect(p.meta).toBeNull();
    expect(p.end).toBeNull();
    expect(p.containers.size).toBe(0);
    expect(p.downsamples).toHaveLength(0);
    expect(p.invalidLines).toBe(4);
  });
});

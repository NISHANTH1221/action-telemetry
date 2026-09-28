import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, iso, pct } from '../src/format';

describe('format', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
  });
  it('formats durations', () => {
    expect(formatDuration(42.4)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 7m');
  });
  it('formats percentages and nulls', () => {
    expect(pct(12.345)).toBe('12.3%');
    expect(pct(null)).toBe('–');
  });
  it('formats epoch seconds as ISO', () => {
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});

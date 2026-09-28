import { describe, expect, it } from 'vitest';
import { escapeHtml, minMaxBucket, renderHtml } from '../src/render/html';
import { makeReport } from './fixtures';

describe('minMaxBucket', () => {
  it('returns short series unchanged', () => {
    const pts: [number, number][] = [[1, 1], [2, 2]];
    expect(minMaxBucket(pts, 10)).toBe(pts);
  });
  it('bounds long series and keeps spikes, in time order', () => {
    const pts: [number, number][] = Array.from({ length: 10_000 }, (_, i) => [i, i % 100]);
    pts[5000] = [5000, 1e6];
    const out = minMaxBucket(pts, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.some((p) => p[1] === 1e6)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThanOrEqual(out[i - 1][0]);
  });
});

describe('renderHtml', () => {
  const { report, samples } = makeReport();
  const html = renderHtml(report, samples);

  it('is a complete, self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script|<link|@import|url\(/i);
  });

  it('draws five charts, plus container memory when containers exist', () => {
    expect(html.match(/<svg /g)).toHaveLength(6);
    const noCtr = renderHtml({ ...report, containers: [] }, samples);
    expect(noCtr.match(/<svg /g)).toHaveLength(5);
  });

  it('follows the minimalist-ui rules: tokens, dark mode, reduced motion, no emoji', () => {
    expect(html).toContain('--bg:#FBFBFA');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('prefers-reduced-motion:reduce');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toMatch(/\bInter\b|Roboto/);
  });

  it('shows step bands, tables and an OK pill when there are no findings', () => {
    expect(html).toContain('<title>build · CI telemetry</title>');
    expect(html).toContain('Build | test');
    expect(html).toContain('postgres:16');
    expect(html).toContain('class="tag tag-ok"');
  });

  it('renders findings as pills and marks OOM events', () => {
    const withOom = {
      ...report,
      oom_events: [{ t: samples[2].t, process: 'node', pid: 7, source: 'kernel' as const, step: 'Build | test' }],
      findings: [{ level: 'error' as const, code: 'oom', message: 'OOM kill of node (pid 7)', step: null }],
    };
    const out = renderHtml(withOom, samples);
    expect(out).toContain('class="tag tag-error"');
    expect(out).toContain('class="oom"');
  });

  it('escapes user-controlled text', () => {
    const evil = { ...report, steps: report.steps!.map((s) => ({ ...s, name: '<img src=x onerror=alert(1)>' })) };
    const out = renderHtml(evil, samples);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml(`a&"'`)).toBe('a&amp;&quot;&#39;');
  });

  it('renders without samples or steps', () => {
    const out = renderHtml({ ...report, steps: null, steps_error: 'no github-token available', containers: [] }, []);
    expect(out).toContain('Per-step breakdown unavailable: no github-token available');
  });
});

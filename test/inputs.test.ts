import { describe, expect, it } from 'vitest';
import { readInputs } from '../src/inputs';

const getter = (values: Record<string, string>) => (name: string) => values[name] ?? '';

describe('readInputs', () => {
  it('returns defaults for empty inputs', () => {
    const warnings: string[] = [];
    expect(readInputs(getter({}), (m) => warnings.push(m))).toEqual({
      interval: 1, processInterval: 5, docker: true, githubToken: '', artifactName: '',
      retentionDays: 7, jobSummary: true, htmlReport: true,
    });
    expect(warnings).toEqual([]);
  });

  it('parses valid values', () => {
    const i = readInputs(getter({
      interval: '2', 'process-interval': '0', docker: 'FALSE', 'github-token': ' tok ',
      'artifact-name': 'my-telemetry', 'retention-days': '30', 'job-summary': 'false', 'html-report': 'true',
    }), () => {});
    expect(i).toEqual({
      interval: 2, processInterval: 0, docker: false, githubToken: 'tok', artifactName: 'my-telemetry',
      retentionDays: 30, jobSummary: false, htmlReport: true,
    });
  });

  it('falls back to defaults with a warning for invalid values', () => {
    const warnings: string[] = [];
    const i = readInputs(getter({ interval: '0', 'process-interval': 'abc', docker: 'yes', 'retention-days': '400' }), (m) => warnings.push(m));
    expect(i.interval).toBe(1);
    expect(i.processInterval).toBe(5);
    expect(i.docker).toBe(true);
    expect(i.retentionDays).toBe(7);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("'interval'");
  });
});

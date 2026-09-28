import { describe, expect, it } from 'vitest';
import { ApiJob, fetchSteps, FetchStepsOptions, selectCurrentJob, toStepTimings } from '../src/steps';

const iso = (s: number) => new Date(s * 1000).toISOString();
const T = 1_759_050_000;

function job(o: Partial<ApiJob> = {}): ApiJob {
  return {
    id: 1, name: 'build', status: 'in_progress', runner_name: 'GitHub Actions 7', started_at: iso(T),
    html_url: 'https://github.com/o/r/actions/runs/9/job/1',
    steps: [
      { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success', started_at: iso(T), completed_at: iso(T + 2) },
      { name: 'Build', number: 2, status: 'completed', conclusion: 'success', started_at: iso(T + 2), completed_at: iso(T + 40) },
      { name: 'Deploy', number: 3, status: 'pending', conclusion: null, started_at: null, completed_at: null },
      { name: 'Post telemetry', number: 4, status: 'in_progress', conclusion: null, started_at: iso(T + 40), completed_at: null },
    ],
    ...o,
  };
}

const opts = (fetchFn: any, o: Partial<FetchStepsOptions> = {}): FetchStepsOptions => ({
  apiUrl: 'https://api.github.com', token: 't', repository: 'o/r', runId: '9', runAttempt: '1',
  runnerName: 'GitHub Actions 7', jobStartedAt: T, fetchFn, ...o,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('toStepTimings', () => {
  it('converts to epoch seconds and drops steps that never started', () => {
    expect(toStepTimings(job())).toEqual([
      { name: 'Set up job', number: 1, conclusion: 'success', started_at: T, completed_at: T + 2 },
      { name: 'Build', number: 2, conclusion: 'success', started_at: T + 2, completed_at: T + 40 },
      { name: 'Post telemetry', number: 4, conclusion: null, started_at: T + 40, completed_at: null },
    ]);
  });
});

describe('selectCurrentJob', () => {
  it('matches in-progress job on this runner, closest start wins', () => {
    const jobs = [
      job({ id: 1, runner_name: 'other' }),
      job({ id: 2, status: 'completed' }),
      job({ id: 3, started_at: iso(T - 500) }),
      job({ id: 4, started_at: iso(T - 3) }),
    ];
    expect(selectCurrentJob(jobs, 'GitHub Actions 7', T)?.id).toBe(4);
    expect(selectCurrentJob(jobs, 'nobody', T)).toBeNull();
  });
});

describe('fetchSteps', () => {
  it('fetches, authenticates and returns steps', async () => {
    const urls: string[] = [];
    const r = await fetchSteps(opts(async (url: string, init: any) => {
      urls.push(url);
      expect(init.headers.authorization).toBe('Bearer t');
      return json({ total_count: 1, jobs: [job()] });
    }));
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/actions/runs/9/attempts/1/jobs?per_page=100&page=1');
    expect(r.steps).toHaveLength(3);
    expect(r.jobName).toBe('build');
    expect(r.error).toBeUndefined();
  });

  it('follows pagination', async () => {
    const others = Array.from({ length: 100 }, (_, i) => job({ id: 100 + i, runner_name: `r${i}` }));
    const r = await fetchSteps(opts(async (url: string) =>
      url.endsWith('page=1') ? json({ total_count: 101, jobs: others }) : json({ total_count: 101, jobs: [job({ id: 7 })] })));
    expect(r.steps).not.toBeNull();
  });

  it('reports HTTP errors without throwing', async () => {
    const r = await fetchSteps(opts(async () => json({ message: 'Resource not accessible by integration' }, 403)));
    expect(r.steps).toBeNull();
    expect(r.error).toContain('403');
  });

  it('reports network errors and missing tokens without throwing', async () => {
    const r1 = await fetchSteps(opts(async () => { throw new Error('ECONNRESET'); }));
    expect(r1).toEqual({ steps: null, error: 'could not fetch step timings: ECONNRESET' });
    const r2 = await fetchSteps(opts(async () => json({}), { token: '' }));
    expect(r2.error).toBe('no github-token available');
  });

  it('reports when no job matches', async () => {
    const r = await fetchSteps(opts(async () => json({ total_count: 1, jobs: [job({ runner_name: 'x' })] })));
    expect(r.error).toContain("no in-progress job found for runner 'GitHub Actions 7'");
  });
});

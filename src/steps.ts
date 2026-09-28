import { StepTiming } from './types';

export interface ApiStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface ApiJob {
  id: number;
  name: string;
  status: string;
  runner_name: string | null;
  started_at: string;
  html_url: string;
  steps?: ApiStep[];
}

export interface StepsResult {
  steps: StepTiming[] | null;
  error?: string;
  jobName?: string;
  jobUrl?: string;
}

export interface FetchStepsOptions {
  apiUrl: string;
  token: string;
  repository: string;
  runId: string;
  runAttempt: string;
  runnerName: string;
  jobStartedAt: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const toEpoch = (iso: string | null): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? null : v / 1000;
};

export function selectCurrentJob(jobs: ApiJob[], runnerName: string, jobStartedAt: number): ApiJob | null {
  const candidates = jobs.filter((j) => j.status === 'in_progress' && j.runner_name === runnerName);
  if (candidates.length === 0) return null;
  const gap = (j: ApiJob) => Math.abs((toEpoch(j.started_at) ?? 0) - jobStartedAt);
  return candidates.reduce((best, j) => (gap(j) < gap(best) ? j : best));
}

/** Steps that never started (skipped/pending with no start time) are dropped. */
export function toStepTimings(job: ApiJob): StepTiming[] {
  return (job.steps ?? [])
    .flatMap((s) => {
      const start = toEpoch(s.started_at);
      if (start === null) return [];
      return [{ name: s.name, number: s.number, conclusion: s.conclusion, started_at: start, completed_at: toEpoch(s.completed_at) }];
    })
    .sort((a, b) => a.number - b.number);
}

/** One paginated call during post. Never rejects: failures come back as `error`. */
export async function fetchSteps(o: FetchStepsOptions): Promise<StepsResult> {
  if (!o.token) return { steps: null, error: 'no github-token available' };
  const fetchFn = o.fetchFn ?? fetch;
  const jobs: ApiJob[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const url = `${o.apiUrl}/repos/${o.repository}/actions/runs/${o.runId}/attempts/${o.runAttempt}/jobs?per_page=100&page=${page}`;
      const res = await fetchFn(url, {
        headers: {
          authorization: `Bearer ${o.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ci-telemetry',
        },
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        return { steps: null, error: `GitHub API returned ${res.status} when listing jobs (does the token have actions: read?)` };
      }
      const body = (await res.json()) as { total_count: number; jobs: ApiJob[] };
      jobs.push(...body.jobs);
      if (jobs.length >= body.total_count || body.jobs.length < 100) break;
    }
  } catch (e) {
    return { steps: null, error: `could not fetch step timings: ${(e as Error).message}` };
  }
  const job = selectCurrentJob(jobs, o.runnerName, o.jobStartedAt);
  if (!job) return { steps: null, error: `no in-progress job found for runner '${o.runnerName}'` };
  return { steps: toStepTimings(job), jobName: job.name, jobUrl: job.html_url };
}

import { aggregateContainers, aggregateSteps, ContainerStats, JobTotals, jobTotals, StepStats, stepAt } from './aggregate';
import type { StopResult } from './collector-control';
import { computeFindings, Finding } from './findings';
import { iso, round2 } from './format';
import { collectorOomEvent, containerOomEvents, OomEvent, parseDmesg } from './oom';
import type { StepsResult } from './steps';
import { ParsedSamples } from './types';

export interface Report {
  schema_version: 1;
  generated_at: string;
  job: {
    repository: string; workflow: string; job: string; job_name: string | null; run_id: string;
    run_attempt: string; sha: string; ref: string; runner_name: string; url: string | null;
  };
  runner: { cpus: number | null; mem_total: number | null; os: string; arch: string | null; kernel: string | null };
  capabilities: { psi: boolean; docker_cgroups: boolean; docker_socket: boolean; steps_api: boolean; dmesg: boolean };
  steps: StepStats[] | null;
  steps_error?: string;
  totals: JobTotals;
  containers: ContainerStats[];
  oom_events: OomEvent[];
  findings: Finding[];
  collector: {
    peak_rss: number | null;
    cpu_seconds: number | null;
    avg_cpu_pct: number | null;
    end_reason: 'sigterm' | 'watch-pid-gone' | 'max-duration' | 'missing' | 'not-started';
    invalid_lines: number;
  };
}

export interface BuildReportInput {
  parsed: ParsedSamples;
  steps: StepsResult;
  dmesg: string | null;
  stopResult: StopResult | 'not-started';
  env: Record<string, string | undefined>;
  now: number;
}

export function buildReport(i: BuildReportInput): Report {
  const p = i.parsed;
  const steps = i.steps.steps;
  const from = p.meta?.t ?? p.samples[0]?.t ?? i.now;
  const oom = [
    ...(i.dmesg !== null ? parseDmesg(i.dmesg, from, i.now) : []),
    ...containerOomEvents(p.samples, p.containers),
    ...collectorOomEvent(p, i.stopResult),
  ]
    .map((e) => ({ ...e, step: steps ? stepAt(e.t, steps)?.name ?? null : null }))
    .sort((a, b) => a.t - b.t);

  const stepStats = steps ? aggregateSteps(p, steps) : null;
  const totals = jobTotals(p);
  const endReason = (p.end?.reason ?? (i.stopResult === 'not-started' ? 'not-started' : 'missing')) as Report['collector']['end_reason'];
  const wall = p.end && p.meta ? p.end.t - p.meta.t : 0;
  const e = i.env;

  const report: Report = {
    schema_version: 1,
    generated_at: iso(i.now),
    job: {
      repository: e.GITHUB_REPOSITORY ?? '',
      workflow: e.GITHUB_WORKFLOW ?? '',
      job: e.GITHUB_JOB ?? '',
      job_name: i.steps.jobName ?? null,
      run_id: e.GITHUB_RUN_ID ?? '',
      run_attempt: e.GITHUB_RUN_ATTEMPT ?? '',
      sha: e.GITHUB_SHA ?? '',
      ref: e.GITHUB_REF ?? '',
      runner_name: e.RUNNER_NAME ?? '',
      url: i.steps.jobUrl ?? null,
    },
    runner: {
      cpus: p.meta?.cpus ?? null,
      mem_total: p.meta?.mem_total ?? null,
      os: 'Linux',
      arch: p.meta?.arch ?? null,
      kernel: p.meta?.kernel ?? null,
    },
    capabilities: {
      psi: p.meta?.capabilities.psi ?? false,
      docker_cgroups: p.meta?.capabilities.docker_cgroups ?? false,
      docker_socket: p.meta?.capabilities.docker_socket ?? false,
      steps_api: steps !== null,
      dmesg: i.dmesg !== null,
    },
    steps: stepStats,
    totals,
    containers: aggregateContainers(p),
    oom_events: oom,
    findings: computeFindings({ steps: stepStats, totals, oom }),
    collector: {
      peak_rss: p.end?.self.peak_rss ?? null,
      cpu_seconds: p.end?.self.cpu_seconds ?? null,
      avg_cpu_pct: p.end && wall > 0 ? round2((p.end.self.cpu_seconds / wall) * 100) : null,
      end_reason: endReason,
      invalid_lines: p.invalidLines,
    },
  };
  if (i.steps.error) report.steps_error = i.steps.error;
  return report;
}

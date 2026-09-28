import * as path from 'node:path';
import type { StopResult } from './collector-control';
import type { Inputs } from './inputs';
import { renderHtml } from './render/html';
import { renderSummary } from './render/summary';
import { buildReport } from './report';
import { parseSamples } from './samples';
import type { FetchStepsOptions, StepsResult } from './steps';
import { artifactUrl, defaultArtifactName, sanitizeName } from './upload';

export interface PostDeps {
  getState(name: string): string;
  env: Record<string, string | undefined>;
  inputs: Inputs;
  stop(pid: number): Promise<StopResult>;
  readText(file: string): string | null;
  writeText(file: string, text: string): void;
  fetchSteps(o: FetchStepsOptions): Promise<StepsResult>;
  readDmesg(): Promise<string | null>;
  writeSummary(markdown: string): Promise<void>;
  upload(name: string, files: string[], rootDir: string, retentionDays: number): Promise<{ id: number | null; name: string }>;
  warning(msg: string): void;
  info(msg: string): void;
  now(): number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const UNAVAILABLE = '## CI telemetry\n\n_Telemetry was unavailable for this job: the collector did not start. See the warnings in the ci-telemetry step._\n';

/** Never rejects: telemetry must not fail the user's job. */
export async function runPost(d: PostDeps): Promise<void> {
  try {
    await postInner(d);
  } catch (e) {
    d.warning(`ci-telemetry: ${msg(e)}`);
  }
}

async function postInner(d: PostDeps): Promise<void> {
  const enabled = d.getState('enabled');
  if (enabled === 'false') return;
  if (enabled !== 'true') {
    if (d.inputs.jobSummary) await d.writeSummary(UNAVAILABLE);
    return;
  }

  const pid = Number(d.getState('pid'));
  const dataDir = d.getState('dataDir');
  const dataFile = d.getState('dataFile');
  const startedAt = Number(d.getState('startedAt'));

  const stopResult = await d.stop(pid).catch((): StopResult => 'not-running');
  const raw = d.readText(dataFile);
  const parsed = parseSamples(raw ?? '');
  if (parsed.invalidLines) d.info(`ci-telemetry: skipped ${parsed.invalidLines} unreadable sample line(s)`);

  const steps = await d
    .fetchSteps({
      apiUrl: d.env.GITHUB_API_URL ?? 'https://api.github.com',
      token: d.inputs.githubToken,
      repository: d.env.GITHUB_REPOSITORY ?? '',
      runId: d.env.GITHUB_RUN_ID ?? '',
      runAttempt: d.env.GITHUB_RUN_ATTEMPT ?? '1',
      runnerName: d.env.RUNNER_NAME ?? '',
      jobStartedAt: startedAt,
    })
    .catch((e): StepsResult => ({ steps: null, error: msg(e) }));
  if (steps.error) d.warning(`ci-telemetry: per-step breakdown unavailable: ${steps.error}`);
  const dmesg = await d.readDmesg().catch(() => null);

  const collectorPid = Number.isInteger(pid) && pid > 0 ? pid : null;
  const report = buildReport({ parsed, steps, dmesg, stopResult, collectorPid, env: d.env, now: d.now() });
  const files: string[] = [];
  try {
    const reportPath = path.join(dataDir, 'report.json');
    d.writeText(reportPath, JSON.stringify(report, null, 2));
    files.push(reportPath);
  } catch (e) {
    d.warning(`ci-telemetry: could not write report.json: ${msg(e)}`);
  }
  if (raw !== null) files.push(dataFile);

  if (d.inputs.htmlReport) {
    try {
      const htmlPath = path.join(dataDir, 'report.html');
      d.writeText(htmlPath, renderHtml(report, parsed.samples));
      files.push(htmlPath);
    } catch (e) {
      d.warning(`ci-telemetry: could not render the HTML report: ${msg(e)}`);
    }
  }

  if (d.inputs.jobSummary) {
    try {
      await d.writeSummary(renderSummary(report));
    } catch (e) {
      d.warning(`ci-telemetry: could not write the job summary: ${msg(e)}`);
    }
  }

  try {
    const name = d.inputs.artifactName ? sanitizeName(d.inputs.artifactName) : defaultArtifactName(d.env, startedAt);
    const up = await d.upload(name, files, dataDir, d.inputs.retentionDays);
    const url = artifactUrl(d.env, up.id);
    d.info(`ci-telemetry: uploaded artifact '${up.name}'${url ? ` → ${url}` : ''}`);
  } catch (e) {
    d.warning(`ci-telemetry: artifact upload failed: ${msg(e)}`);
  }
}

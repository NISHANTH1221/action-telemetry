import * as core from '@actions/core';

export interface Inputs {
  interval: number;
  processInterval: number;
  docker: boolean;
  githubToken: string;
  artifactName: string;
  retentionDays: number;
  jobSummary: boolean;
  htmlReport: boolean;
}

type Getter = (name: string) => string;
type Warn = (msg: string) => void;

function num(get: Getter, warn: Warn, name: string, def: number, min: number, max: number): number {
  const raw = get(name).trim();
  if (raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    warn(`ci-telemetry: input '${name}' must be a number between ${min} and ${max}; got '${raw}', using ${def}`);
    return def;
  }
  return v;
}

function bool(get: Getter, warn: Warn, name: string, def: boolean): boolean {
  const raw = get(name).trim().toLowerCase();
  if (raw === '') return def;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  warn(`ci-telemetry: input '${name}' must be true or false; got '${raw}', using ${def}`);
  return def;
}

/** Never throws: invalid values fall back to their defaults with a warning. */
export function readInputs(get: Getter = (n) => core.getInput(n), warn: Warn = core.warning): Inputs {
  return {
    interval: num(get, warn, 'interval', 1, 1, 60),
    processInterval: num(get, warn, 'process-interval', 5, 0, 300),
    docker: bool(get, warn, 'docker', true),
    githubToken: get('github-token').trim(),
    artifactName: get('artifact-name').trim(),
    retentionDays: Math.round(num(get, warn, 'retention-days', 7, 1, 90)),
    jobSummary: bool(get, warn, 'job-summary', true),
    htmlReport: bool(get, warn, 'html-report', true),
  };
}

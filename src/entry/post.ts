import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import * as fs from 'node:fs';
import { stopCollector } from '../collector-control';
import { Inputs, readInputs } from '../inputs';
import { readDmesg } from '../oom';
import { runPost } from '../post';
import { fetchSteps } from '../steps';
import { uploadWithRetry } from '../upload';

// Nothing at module scope may throw: the action must never fail the user's job.
try {
  let inputs: Inputs | null = null;
  try {
    inputs = readInputs(core.getInput, () => {}); // main already warned about bad inputs
  } catch (e) {
    core.warning(`ci-telemetry: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (inputs) {
    runPost({
      getState: core.getState,
      env: process.env,
      inputs,
      stop: (pid) => stopCollector(pid),
      readText: (f) => {
        try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
      },
      writeText: (f, t) => fs.writeFileSync(f, t),
      fetchSteps,
      readDmesg: () => readDmesg(),
      writeSummary: async (md) => { await core.summary.addRaw(md).write(); },
      upload: (name, files, root, days) => uploadWithRetry(new DefaultArtifactClient(), name, files, root, days),
      warning: (m) => core.warning(m),
      info: core.info,
      now: () => Date.now() / 1000,
    }).catch(() => {});
  }
} catch {
  // Defence in depth: runPost already never rejects.
}

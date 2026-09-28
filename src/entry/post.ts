import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import * as fs from 'node:fs';
import { stopCollector } from '../collector-control';
import { readInputs } from '../inputs';
import { readDmesg } from '../oom';
import { runPost } from '../post';
import { fetchSteps } from '../steps';
import { uploadWithRetry } from '../upload';

const client = new DefaultArtifactClient();

runPost({
  getState: core.getState,
  env: process.env,
  inputs: readInputs(core.getInput, () => {}), // main already warned about bad inputs
  stop: (pid) => stopCollector(pid),
  readText: (f) => {
    try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
  },
  writeText: (f, t) => fs.writeFileSync(f, t),
  fetchSteps,
  readDmesg: () => readDmesg(),
  writeSummary: async (md) => { await core.summary.addRaw(md).write(); },
  upload: (name, files, root, days) => uploadWithRetry(client, name, files, root, days),
  warning: (m) => core.warning(m),
  info: core.info,
  now: () => Date.now() / 1000,
}).catch(() => {});

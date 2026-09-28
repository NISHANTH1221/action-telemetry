import * as core from '@actions/core';
import * as path from 'node:path';
import { startCollector } from '../collector-control';
import { readInputs } from '../inputs';
import { runMain } from '../main';
import { findRunnerWorkerPid } from '../runner';

runMain({
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  binDir: path.join(__dirname, '..', 'bin'), // dist/main/index.js → dist/bin
  env: process.env,
  readInputs: () => readInputs(),
  findWorker: (pid) => findRunnerWorkerPid(pid),
  start: (o) => startCollector(o),
  saveState: core.saveState,
  notice: (m) => core.notice(m),
  warning: (m) => core.warning(m),
  info: core.info,
  now: () => Date.now() / 1000,
});

// Validates every downloaded e2e artifact against the schema and each scenario's expectations.
import Ajv from 'ajv';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'artifacts';
const failures = [];
const expect = (cond, msg) => { if (!cond) failures.push(msg); };

const schema = JSON.parse(readFileSync('schema/report.schema.json', 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

const reports = {};
for (const dir of readdirSync(root)) {
  const file = join(root, dir, 'report.json');
  if (!existsSync(file)) { failures.push(`${dir}: report.json missing`); continue; }
  const r = JSON.parse(readFileSync(file, 'utf8'));
  if (!validate(r)) failures.push(`${dir}: schema errors ${JSON.stringify(validate.errors)}`);
  expect(existsSync(join(root, dir, 'report.html')), `${dir}: report.html missing`);
  expect(existsSync(join(root, dir, 'samples.ndjson')), `${dir}: samples.ndjson missing`);
  reports[dir] = r;
}
const of = (job) => Object.entries(reports).filter(([n]) => n.startsWith(`ci-telemetry-${job}-`)).map(([, r]) => r);

const normal = of('normal');
expect(normal.length === 2, `normal: expected 2 artifacts (x64 + arm64, distinct names), got ${normal.length}`);
for (const r of normal) {
  expect(Array.isArray(r.steps) && r.steps.some((s) => s.name === 'Busy work' && s.samples > 0 && s.cpu_max > 20), 'normal: "Busy work" step with CPU load');
  expect(r.collector.end_reason === 'sigterm', `normal: end_reason ${r.collector.end_reason}`);
}

expect(of('failing-step').length === 1, 'failing-step: post must still upload after a failed step');

const hostOom = of('host-oom')[0];
expect(hostOom?.oom_events.some((e) => e.source === 'kernel' && e.step === 'Trigger host OOM'), 'host-oom: kernel OOM event attributed to the OOM step');

const ctrOom = of('container-oom')[0];
expect(ctrOom?.containers.some((c) => c.name === 'oomy' && c.oom_kills >= 1), 'container-oom: container "oomy" with oom_kills >= 1');
expect(ctrOom?.oom_events.some((e) => e.source === 'container'), 'container-oom: container OOM event');

const svc = of('service-container')[0];
expect(svc?.containers.some((c) => (c.image ?? '').startsWith('postgres:16')), 'service-container: postgres:16 container');

const noPerm = of('no-permissions')[0];
expect(noPerm && noPerm.steps === null && typeof noPerm.steps_error === 'string', 'no-permissions: steps null with steps_error');

const oh = of('overhead')[0];
expect(oh?.collector.peak_rss != null && oh.collector.peak_rss <= 5 * 1024 * 1024, `overhead: peak_rss ${oh?.collector.peak_rss} > 5 MiB`);
expect(oh?.collector.avg_cpu_pct != null && oh.collector.avg_cpu_pct <= 0.5, `overhead: avg_cpu_pct ${oh?.collector.avg_cpu_pct} > 0.5`);

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✓ verified ${Object.keys(reports).length} reports`);

import { formatBytes, formatDuration, pct } from '../format';
import { Report } from '../report';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\r?\n/g, ' ');
const bytes = (n: number | null) => (n === null ? '–' : formatBytes(n));

export function renderSummary(r: Report): string {
  const out: string[] = ['## CI telemetry', ''];
  const size = r.runner.cpus !== null && r.runner.mem_total !== null
    ? `${r.runner.cpus} vCPU / ${formatBytes(r.runner.mem_total)}`
    : 'unknown size';
  const overhead = r.collector.peak_rss !== null
    ? `collector overhead ${formatBytes(r.collector.peak_rss)} RSS, ${pct(r.collector.avg_cpu_pct)} CPU`
    : 'collector overhead unknown';
  out.push(`**Runner:** ${size} · **Sampled:** ${formatDuration(r.totals.duration_s)} · ${overhead}`, '');

  if (r.findings.length) {
    out.push('### Findings', '');
    for (const f of r.findings) out.push(`- ${f.level === 'error' ? '🔴' : '⚠️'} ${esc(f.message)}`);
    out.push('');
  }

  if (r.steps) {
    out.push('### Steps', '',
      '| # | Step | Duration | CPU avg | CPU max | Peak memory | Max mem pressure | Max I/O pressure |',
      '|---:|---|---:|---:|---:|---:|---:|---:|');
    for (const s of r.steps) {
      out.push(`| ${s.number} | ${esc(s.name)} | ${formatDuration(s.duration_s)} | ${pct(s.cpu_avg)} | ${pct(s.cpu_max)} | ${bytes(s.mem_peak)} | ${pct(s.psi_max?.mem_full ?? null)} | ${pct(s.psi_max?.io_full ?? null)} |`);
    }
    out.push('');
  } else {
    out.push(`_Per-step breakdown unavailable: ${esc(r.steps_error ?? 'unknown reason')}_`, '');
  }

  if (r.containers.length) {
    out.push('### Containers', '', '| Container | Image | CPU avg | CPU max | Peak memory | OOM kills |', '|---|---|---:|---:|---:|---:|');
    for (const c of r.containers) {
      out.push(`| ${esc(c.name)} | ${esc(c.image ?? '–')} | ${pct(c.cpu_avg)} | ${pct(c.cpu_max)} | ${formatBytes(c.mem_peak)} | ${c.oom_kills} |`);
    }
    out.push('');
  }

  out.push('_Download the ci-telemetry artifact for the full HTML report and raw samples._');
  return out.join('\n') + '\n';
}

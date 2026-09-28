import { formatBytes, formatDuration, pct } from '../format';
import { Report } from '../report';
import { Sample } from '../types';

type Point = [number, number];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`);

/** Reduce to about maxPoints by keeping each bucket's min and max, so short spikes survive. */
export function minMaxBucket(points: Point[], maxPoints = 2000): Point[] {
  if (points.length <= maxPoints) return points;
  const buckets = Math.floor(maxPoints / 2);
  const size = points.length / buckets;
  const out: Point[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = points.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!slice.length) continue;
    let lo = slice[0];
    let hi = slice[0];
    for (const p of slice) {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
  }
  return out;
}

interface Series { label: string; tone: number; points: Point[]; area?: boolean }
interface Band { start: number; end: number; label: string }
interface ChartOpts {
  title: string;
  series: Series[];
  bands: Band[];
  markers: number[];
  t0: number;
  t1: number;
  yMax?: number;
  yFormat: (v: number) => string;
}

const W = 960;
const H = 220;
const L = 64;
const R = 16;
const TOP = 28;
const BOTTOM = 28;
const f1 = (n: number) => n.toFixed(1);

function chart(o: ChartOpts, i: number): string {
  const span = Math.max(1e-9, o.t1 - o.t0);
  const series = o.series.map((s) => ({ ...s, points: minMaxBucket(s.points) }));
  let peak = 0;
  for (const s of series) for (const p of s.points) if (p[1] > peak) peak = p[1];
  const yMax = o.yMax ?? (peak > 0 ? peak * 1.1 : 1);
  const x = (t: number) => L + ((t - o.t0) / span) * (W - L - R);
  const y = (v: number) => TOP + (1 - Math.min(Math.max(v, 0), yMax) / yMax) * (H - TOP - BOTTOM);
  const parts: string[] = [];

  o.bands.forEach((b, bi) => {
    const x0 = x(Math.max(b.start, o.t0));
    const x1 = x(Math.min(b.end, o.t1));
    if (x1 - x0 < 1) return;
    parts.push(`<rect class="band${bi % 2}" x="${f1(x0)}" y="${TOP}" width="${f1(x1 - x0)}" height="${H - TOP - BOTTOM}"><title>${escapeHtml(b.label)}</title></rect>`);
    const room = Math.floor((x1 - x0 - 8) / 6);
    if (room >= 4) parts.push(`<text class="blabel" x="${f1(x0 + 4)}" y="${TOP - 8}">${escapeHtml(truncate(b.label, room))}</text>`);
  });
  for (const g of [0, 0.5, 1]) {
    const yy = f1(y(yMax * g));
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="ylabel" x="${L - 8}" y="${yy}" dy="3">${escapeHtml(o.yFormat(yMax * g))}</text>`);
  }
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    const anchor = g === 0 ? 'start' : g === 1 ? 'end' : 'middle';
    parts.push(`<text class="xlabel" text-anchor="${anchor}" x="${f1(L + g * (W - L - R))}" y="${H - 8}">${formatDuration(g * span)}</text>`);
  }
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, pi) => `${pi ? 'L' : 'M'}${f1(x(p[0]))} ${f1(y(p[1]))}`).join('');
    if (s.area) {
      const last = s.points[s.points.length - 1][0];
      parts.push(`<path class="ar t${s.tone}" d="${d}L${f1(x(last))} ${f1(y(0))}L${f1(x(s.points[0][0]))} ${f1(y(0))}Z"/>`);
    }
    parts.push(`<path class="ln t${s.tone}" d="${d}"/>`);
  }
  for (const m of o.markers) {
    if (m < o.t0 || m > o.t1) continue;
    const xx = f1(x(m));
    parts.push(`<line class="oom" x1="${xx}" x2="${xx}" y1="${TOP}" y2="${H - BOTTOM}"/>`);
  }
  const legend = o.series.map((s) => `<span class="key t${s.tone}"><i></i>${escapeHtml(s.label)}</span>`).join('');
  return `<figure class="card chart reveal" style="--i:${i}"><figcaption><span class="ctitle">${escapeHtml(o.title)}</span><span class="legend">${legend}</span></figcaption>`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(o.title)}">${parts.join('')}</svg></figure>`;
}

function containerStack(samples: Sample[], r: Report): Series[] {
  const ids = r.containers.map((c) => c.id);
  const cum: Point[][] = ids.map(() => []);
  for (const s of samples) {
    if (!s.ctr) continue;
    let acc = 0;
    ids.forEach((id, i) => {
      acc += s.ctr!.find((c) => c.id === id)?.mem ?? 0;
      cum[i].push([s.t, acc]);
    });
  }
  // Largest cumulative series first so smaller areas paint on top of it.
  return ids.map((_, i) => ({ label: r.containers[i].name, tone: i % 6, points: cum[i], area: true })).reverse();
}

function table(cols: Array<{ h: string; num?: boolean }>, rows: string[][]): string {
  const th = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${escapeHtml(c.h)}</th>`).join('');
  const tr = rows.map((row) => `<tr>${row.map((cell, i) => `<td${cols[i].num ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

const bytes = (n: number | null) => (n === null ? '–' : formatBytes(n));

function stat(label: string, value: string, note: string, width: 2 | 3, i: number): string {
  return `<div class="card stat w${width} reveal" style="--i:${i}"><div class="label">${escapeHtml(label)}</div>`
    + `<div class="value">${escapeHtml(value)}</div><div class="note">${escapeHtml(note)}</div></div>`;
}

export function renderHtml(r: Report, samples: Sample[]): string {
  const t0 = samples.length ? samples[0].t : 0;
  const t1 = samples.length > 1 ? samples[samples.length - 1].t : t0 + 1;
  const bands: Band[] = (r.steps ?? [])
    .filter((s) => s.samples > 0)
    .map((s) => ({ start: Date.parse(s.started_at) / 1000, end: s.completed_at ? Date.parse(s.completed_at) / 1000 : t1, label: s.name }));
  const markers = r.oom_events.map((e) => e.t);
  const pts = (f: (s: Sample) => number | null | undefined): Point[] =>
    samples.flatMap((s) => {
      const v = f(s);
      return typeof v === 'number' ? [[s.t, v] as Point] : [];
    });
  const base = { bands, markers, t0, t1 };
  const percent = (v: number) => `${Math.round(v)}%`;
  const perSec = (v: number) => `${formatBytes(v)}/s`;

  const charts = [
    chart({ ...base, title: 'CPU, % of all cores', yMax: 100, yFormat: percent, series: [
      { label: 'user', tone: 0, points: pts((s) => s.cpu.usr), area: true },
      { label: 'system', tone: 1, points: pts((s) => s.cpu.sys) },
      { label: 'iowait', tone: 3, points: pts((s) => s.cpu.iow) },
      { label: 'steal', tone: 4, points: pts((s) => s.cpu.steal) },
    ] }, 0),
    chart({ ...base, title: 'Memory', yMax: r.runner.mem_total ?? undefined, yFormat: formatBytes, series: [
      { label: 'used', tone: 0, points: pts((s) => s.mem.used), area: true },
      { label: 'page cache', tone: 1, points: pts((s) => s.mem.cached) },
      { label: 'swap', tone: 4, points: pts((s) => s.mem.swap) },
    ] }, 1),
    chart({ ...base, title: 'Pressure stall, 10 s average', yMax: 100, yFormat: percent, series: [
      { label: 'cpu some', tone: 1, points: pts((s) => s.psi?.cpu_some) },
      { label: 'memory full', tone: 4, points: pts((s) => s.psi?.mem_full) },
      { label: 'io full', tone: 3, points: pts((s) => s.psi?.io_full) },
    ] }, 2),
    chart({ ...base, title: 'Disk throughput', yFormat: perSec, series: [
      { label: 'read', tone: 1, points: pts((s) => s.disk.rd) },
      { label: 'write', tone: 2, points: pts((s) => s.disk.wr) },
    ] }, 3),
    chart({ ...base, title: 'Network throughput', yFormat: perSec, series: [
      { label: 'in', tone: 1, points: pts((s) => s.net.rx) },
      { label: 'out', tone: 2, points: pts((s) => s.net.tx) },
    ] }, 4),
  ];
  if (r.containers.length) {
    charts.push(chart({ ...base, title: 'Container memory, stacked', yFormat: formatBytes, series: containerStack(samples, r) }, 5));
  }

  const t = r.totals;
  const memNote = t.mem_peak !== null && r.runner.mem_total
    ? `${Math.round((t.mem_peak / r.runner.mem_total) * 100)}% of ${formatBytes(r.runner.mem_total)}`
    : 'runner total unknown';
  const stats = [
    stat('Sampled', formatDuration(t.duration_s), `${t.samples} samples`, 2, 0),
    stat('Peak memory', bytes(t.mem_peak), memNote, 2, 1),
    stat('Memory pressure', pct(t.psi_max?.mem_full ?? null), 'peak PSI full, 10 s average', 2, 2),
    stat('CPU average', pct(t.cpu_avg), `peak ${pct(t.cpu_max)} across ${r.runner.cpus ?? '?'} vCPU`, 3, 3),
    stat('Collector overhead', bytes(r.collector.peak_rss), `${pct(r.collector.avg_cpu_pct)} of one core`, 3, 4),
  ].join('');

  const findings = r.findings.length
    ? r.findings.map((f) => `<li><span class="tag tag-${f.level}">${f.level === 'error' ? 'Error' : 'Warning'}</span><span>${escapeHtml(f.message)}</span></li>`).join('')
    : '<li><span class="tag tag-ok">OK</span><span>No bottlenecks detected.</span></li>';

  const steps = r.steps
    ? table(
        [{ h: '#', num: true }, { h: 'Step' }, { h: 'Duration', num: true }, { h: 'CPU avg', num: true }, { h: 'CPU max', num: true },
          { h: 'Peak mem', num: true }, { h: 'Mem pressure', num: true }, { h: 'I/O pressure', num: true },
          { h: 'Disk read', num: true }, { h: 'Disk write', num: true }, { h: 'Net in', num: true }, { h: 'Net out', num: true }],
        r.steps.map((s) => [
          String(s.number),
          `${escapeHtml(s.name)}${s.conclusion === 'failure' ? '<span class="tag tag-error">Failed</span>' : ''}`,
          formatDuration(s.duration_s), pct(s.cpu_avg), pct(s.cpu_max), bytes(s.mem_peak),
          pct(s.psi_max?.mem_full ?? null), pct(s.psi_max?.io_full ?? null),
          bytes(s.disk_rd), bytes(s.disk_wr), bytes(s.net_rx), bytes(s.net_tx),
        ]),
      )
    : `<p class="lede">Per-step breakdown unavailable: ${escapeHtml(r.steps_error ?? 'unknown reason')}</p>`;

  const containers = r.containers.length
    ? `<section class="reveal" style="--i:3"><h2>Containers</h2>${table(
        [{ h: 'Name' }, { h: 'Image' }, { h: 'CPU avg', num: true }, { h: 'CPU max', num: true }, { h: 'Peak mem', num: true }, { h: 'OOM kills', num: true }],
        r.containers.map((c) => [escapeHtml(c.name), escapeHtml(c.image ?? '–'), pct(c.cpu_avg), pct(c.cpu_max), formatBytes(c.mem_peak), String(c.oom_kills)]),
      )}</section>`
    : '';

  const ooms = r.oom_events.length
    ? `<section class="reveal" style="--i:4"><h2>OOM events</h2>${table(
        [{ h: 'Time (UTC)' }, { h: 'Process' }, { h: 'Source' }, { h: 'Step' }],
        r.oom_events.map((e) => [new Date(e.t * 1000).toISOString().slice(11, 19), escapeHtml(e.pid === null ? e.process : `${e.process} (${e.pid})`), e.source, escapeHtml(e.step ?? '–')]),
      )}</section>`
    : '';

  const title = (r.job.job_name ?? r.job.job) || 'CI job';
  const eyebrow = [r.job.repository, r.job.workflow, r.job.run_id && `run ${r.job.run_id}/${r.job.run_attempt}`, r.job.sha.slice(0, 7)]
    .filter(Boolean).join(' · ');
  const size = r.runner.cpus !== null && r.runner.mem_total !== null ? `${r.runner.cpus} vCPU / ${formatBytes(r.runner.mem_total)}` : 'unknown runner size';
  const lede = `${r.steps?.length ?? 0} steps · ${formatDuration(t.duration_s)} sampled · ${size}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)} · CI telemetry</title><style>${CSS}</style></head><body><main class="wrap">`
    + `<header class="reveal"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(lede)}</p></header>`
    + `<div class="stats">${stats}</div>`
    + `<section class="reveal" style="--i:1"><h2>Findings</h2><ul class="findings">${findings}</ul></section>`
    + `<section><h2 class="reveal">Timeline</h2><div class="charts">${charts.join('')}</div></section>`
    + `<section class="reveal" style="--i:2"><h2>Steps</h2>${steps}</section>`
    + containers + ooms
    + `<footer>Generated ${escapeHtml(r.generated_at)} by ci-telemetry · report schema v${r.schema_version}</footer>`
    + `</main></body></html>`;
}

const CSS = [
  ':root{--bg:#FBFBFA;--surface:#FFFFFF;--band:#F4F3EF;--border:#EAEAEA;--text:#2F3437;--muted:#787774;--strong:#111111;',
  '--c1:#2F3437;--c2:#1F6C9F;--c3:#346538;--c4:#956400;--c5:#9F2F2D;--c6:#6E5A8A;',
  '--red-bg:#FDEBEC;--red:#9F2F2D;--yellow-bg:#FBF3DB;--yellow:#956400;--green-bg:#EDF3EC;--green:#346538;',
  '--sans:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Geist Sans","Helvetica Neue","Switzer",sans-serif;',
  '--serif:"Lyon Text","Newsreader","Iowan Old Style","Charter",Georgia,serif;',
  '--mono:"Geist Mono","SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace;color-scheme:light dark}',
  '@media (prefers-color-scheme:dark){:root{--bg:#191918;--surface:#1F1F1E;--band:#252523;--border:#2F2F2D;--text:#E3E2DE;--muted:#9B9A97;--strong:#F4F3EF;',
  '--c1:#D4D3CF;--c2:#6FB1DB;--c3:#86B98A;--c4:#D9A941;--c5:#E0787A;--c6:#B09CD0;',
  '--red-bg:#3A2324;--red:#E0787A;--yellow-bg:#352D1A;--yellow:#D9A941;--green-bg:#1F2E21;--green:#86B98A}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}',
  '.wrap{max-width:1040px;margin:0 auto;padding:72px 24px 96px}',
  '.eyebrow{font:12px/1.4 var(--mono);color:var(--muted);letter-spacing:.02em;margin:0 0 16px}',
  'h1{font:400 44px/1.1 var(--serif);letter-spacing:-.03em;color:var(--strong);margin:0 0 12px}',
  'h2{font:400 24px/1.2 var(--serif);letter-spacing:-.02em;color:var(--strong);margin:0 0 20px}',
  '.lede{color:var(--muted);margin:0}',
  'section{margin-top:72px}',
  '.card{background:var(--surface);border:1px solid var(--border);border-radius:12px}',
  '.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;margin-top:48px}',
  '.stat{padding:24px}.w2{grid-column:span 2}.w3{grid-column:span 3}',
  '.label,th{font:600 11px/1.4 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}',
  '.value{font:400 34px/1.15 var(--serif);letter-spacing:-.03em;color:var(--strong);margin:10px 0 6px;font-variant-numeric:tabular-nums}',
  '.note{font-size:13px;color:var(--muted)}',
  '.findings{list-style:none;margin:0;padding:0}',
  '.findings li{display:flex;gap:14px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--border)}',
  '.tag{flex:none;border-radius:9999px;padding:2px 10px;font:600 10.5px/1.6 var(--sans);text-transform:uppercase;letter-spacing:.06em}',
  '.tag-error{background:var(--red-bg);color:var(--red)}.tag-warning{background:var(--yellow-bg);color:var(--yellow)}.tag-ok{background:var(--green-bg);color:var(--green)}',
  '.charts{display:grid;gap:16px}',
  '.chart{margin:0;padding:20px 20px 12px}',
  'figcaption{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 20px;margin-bottom:8px}',
  '.ctitle{font-weight:600;font-size:14px;color:var(--strong)}',
  '.legend{display:flex;flex-wrap:wrap;gap:14px;font:12px var(--mono);color:var(--muted)}',
  '.key i{display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c);margin-right:6px}',
  'svg{display:block;width:100%;height:auto;overflow:visible}',
  '.t0{--c:var(--c1)}.t1{--c:var(--c2)}.t2{--c:var(--c3)}.t3{--c:var(--c4)}.t4{--c:var(--c5)}.t5{--c:var(--c6)}',
  '.ln{fill:none;stroke:var(--c);stroke-width:1.5;stroke-linejoin:round}',
  '.ar{fill:var(--c);fill-opacity:.12;stroke:none}',
  '.band0{fill:var(--band)}.band1{fill:transparent}',
  '.blabel,.ylabel,.xlabel{font:10px var(--mono);fill:var(--muted)}.ylabel{text-anchor:end}',
  '.grid{stroke:var(--border);stroke-width:1}',
  '.oom{stroke:var(--red);stroke-width:1.5;stroke-dasharray:3 3}',
  '.table-wrap{overflow-x:auto}',
  'table{width:100%;border-collapse:collapse;font-size:13.5px}',
  'th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);white-space:nowrap}',
  'td{padding:12px;border-bottom:1px solid var(--border);vertical-align:baseline}',
  '.num{text-align:right;font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
  'td .tag{margin-left:8px}',
  'footer{margin-top:72px;font:12px var(--mono);color:var(--muted)}',
  '.reveal{animation:rise .6s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i,0)*80ms)}',
  '@keyframes rise{from{opacity:0;transform:translateY(12px)}}',
  '@media (prefers-reduced-motion:reduce){.reveal{animation:none}}',
  '@media print{.reveal{animation:none}}',
  '@media (max-width:720px){.wrap{padding:40px 16px 64px}h1{font-size:34px}.stats{grid-template-columns:1fr 1fr}.w2,.w3{grid-column:span 1}.w3:last-child{grid-column:span 2}section{margin-top:48px}}',
].join('');

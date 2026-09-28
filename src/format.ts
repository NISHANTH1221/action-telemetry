export const iso = (t: number): string => new Date(t * 1000).toISOString();
export const round1 = (x: number): number => Math.round(x * 10) / 10;
export const round2 = (x: number): number => Math.round(x * 100) / 100;

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const pct = (v: number | null): string => (v === null ? '–' : `${v.toFixed(1)}%`);

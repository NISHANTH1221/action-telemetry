import { Downsample, End, Meta, ParsedSamples, Sample } from './types';

export function emptySamples(): ParsedSamples {
  return { meta: null, samples: [], containers: new Map(), downsamples: [], end: null, invalidLines: 0 };
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSample(r: Record<string, any>): r is Sample {
  return isObj(r.cpu) && isObj(r.mem) && isObj(r.disk) && isObj(r.net);
}

function isMeta(r: Record<string, any>): r is Meta {
  return isObj(r.capabilities) && typeof r.cpus === 'number' && typeof r.interval === 'number' && typeof r.mem_total === 'number';
}

function isEnd(r: Record<string, any>): r is End {
  return typeof r.reason === 'string' && isObj(r.self) && typeof r.self.peak_rss === 'number' && typeof r.self.cpu_seconds === 'number';
}

function isContainer(r: Record<string, any>): boolean {
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.image === 'string';
}

function isDownsample(r: Record<string, any>): r is Downsample {
  return typeof r.interval === 'number';
}

/** Tolerant NDJSON parse: malformed or unexpected lines are counted, never thrown. */
export function parseSamples(text: string): ParsedSamples {
  const out = emptySamples();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      out.invalidLines++;
      continue;
    }
    if (!isObj(rec) || typeof rec.t !== 'number') {
      out.invalidLines++;
      continue;
    }
    switch (rec.type) {
      case 'meta':
        if (isMeta(rec)) out.meta = rec;
        else out.invalidLines++;
        break;
      case 'sample':
        if (isSample(rec)) out.samples.push(rec);
        else out.invalidLines++;
        break;
      case 'container':
        if (isContainer(rec)) out.containers.set(rec.id, { name: rec.name, image: rec.image });
        else out.invalidLines++;
        break;
      case 'downsample':
        if (isDownsample(rec)) out.downsamples.push(rec);
        else out.invalidLines++;
        break;
      case 'end':
        if (isEnd(rec)) out.end = rec;
        else out.invalidLines++;
        break;
      default:
        out.invalidLines++;
    }
  }
  out.samples.sort((a, b) => a.t - b.t);
  return out;
}

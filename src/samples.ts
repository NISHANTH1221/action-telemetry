import { ParsedSamples, Sample } from './types';

export function emptySamples(): ParsedSamples {
  return { meta: null, samples: [], containers: new Map(), downsamples: [], end: null, invalidLines: 0 };
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSample(r: Record<string, any>): r is Sample {
  return isObj(r.cpu) && isObj(r.mem) && isObj(r.disk) && isObj(r.net);
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
        out.meta = rec as ParsedSamples['meta'];
        break;
      case 'sample':
        if (isSample(rec)) out.samples.push(rec);
        else out.invalidLines++;
        break;
      case 'container':
        out.containers.set(String(rec.id), { name: String(rec.name), image: String(rec.image) });
        break;
      case 'downsample':
        out.downsamples.push(rec as ParsedSamples['downsamples'][number]);
        break;
      case 'end':
        out.end = rec as ParsedSamples['end'];
        break;
      default:
        out.invalidLines++;
    }
  }
  out.samples.sort((a, b) => a.t - b.t);
  return out;
}

import { createHash, randomBytes } from 'node:crypto';

type Env = Record<string, string | undefined>;

export function sanitizeName(s: string): string {
  return s.replace(/[":<>|*?\r\n\\/]/g, '-');
}

/** ci-telemetry-<job>-<attempt>-<hash>; the hash separates matrix legs that share GITHUB_JOB. */
export function defaultArtifactName(env: Env, jobStartedAt: number): string {
  const h = createHash('sha1').update(`${env.RUNNER_NAME ?? ''}${jobStartedAt}`).digest('hex').slice(0, 6);
  return sanitizeName(`ci-telemetry-${env.GITHUB_JOB ?? 'job'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}-${h}`);
}

export interface ArtifactUploader {
  uploadArtifact(name: string, files: string[], rootDirectory: string, options?: { retentionDays?: number }): Promise<{ id?: number }>;
}

export function isNameConflict(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /already exists|\(409\)|Conflict/i.test(msg);
}

export async function uploadWithRetry(
  client: ArtifactUploader,
  name: string,
  files: string[],
  rootDir: string,
  retentionDays: number,
  suffix: () => string = () => randomBytes(2).toString('hex'),
): Promise<{ id: number | null; name: string }> {
  try {
    const r = await client.uploadArtifact(name, files, rootDir, { retentionDays });
    return { id: r.id ?? null, name };
  } catch (e) {
    if (!isNameConflict(e)) throw e;
    const retry = `${name}-${suffix()}`;
    const r = await client.uploadArtifact(retry, files, rootDir, { retentionDays });
    return { id: r.id ?? null, name: retry };
  }
}

export function artifactUrl(env: Env, id: number | null): string | null {
  if (id === null || !env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/artifacts/${id}`;
}

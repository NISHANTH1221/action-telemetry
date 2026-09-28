import { describe, expect, it } from 'vitest';
import { artifactUrl, defaultArtifactName, sanitizeName, uploadWithRetry } from '../src/upload';

const env = { GITHUB_JOB: 'build', GITHUB_RUN_ATTEMPT: '2', RUNNER_NAME: 'GitHub Actions 3' };

describe('artifact names', () => {
  it('is deterministic and unique per runner (matrix legs)', () => {
    const a = defaultArtifactName(env, 1000);
    expect(a).toMatch(/^ci-telemetry-build-2-[0-9a-f]{6}$/);
    expect(defaultArtifactName(env, 1000)).toBe(a);
    expect(defaultArtifactName({ ...env, RUNNER_NAME: 'GitHub Actions 4' }, 1000)).not.toBe(a);
  });
  it('replaces characters artifact names cannot contain', () => {
    expect(sanitizeName('a/b:c<d>e|f*g?h"i\\j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });
});

describe('uploadWithRetry', () => {
  it('uploads once when the name is free', async () => {
    const calls: any[] = [];
    const client = { uploadArtifact: async (...a: any[]) => { calls.push(a); return { id: 5 }; } };
    expect(await uploadWithRetry(client, 'n', ['/d/f'], '/d', 7)).toEqual({ id: 5, name: 'n' });
    expect(calls).toEqual([['n', ['/d/f'], '/d', { retentionDays: 7 }]]);
  });

  it('retries once with a suffix on a name conflict', async () => {
    const names: string[] = [];
    const client = {
      uploadArtifact: async (name: string) => {
        names.push(name);
        if (names.length === 1) throw new Error('Failed to CreateArtifact: (409) Conflict: an artifact with this name already exists on the workflow run');
        return { id: 6 };
      },
    };
    expect(await uploadWithRetry(client, 'n', [], '/d', 7, () => 'beef')).toEqual({ id: 6, name: 'n-beef' });
    expect(names).toEqual(['n', 'n-beef']);
  });

  it('rethrows other errors', async () => {
    const client = { uploadArtifact: async () => { throw new Error('network down'); } };
    await expect(uploadWithRetry(client, 'n', [], '/d', 7)).rejects.toThrow('network down');
  });
});

describe('artifactUrl', () => {
  it('builds the run artifact URL when possible', () => {
    const e = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };
    expect(artifactUrl(e, 5)).toBe('https://github.com/o/r/actions/runs/9/artifacts/5');
    expect(artifactUrl({}, 5)).toBeNull();
    expect(artifactUrl(e, null)).toBeNull();
  });
});

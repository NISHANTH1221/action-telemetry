# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| Latest `v1.x` (the `v1` tag) | ✅ |
| Older minor releases | ❌ — upgrade to the latest `v1` |

## Reporting a vulnerability

**Please don't report security issues in public issues, discussions or pull requests.**

Report them privately through GitHub's [private vulnerability reporting](https://github.com/<owner>/ci-telemetry/security/advisories/new). Include:

- the affected version or commit,
- a description of the issue and its impact,
- steps to reproduce, or a proof of concept,
- any suggested fix.

We aim to acknowledge reports within **3 business days** and to agree on a disclosure timeline with you. We're happy to credit reporters in the advisory.

## Scope

Examples of what we'd treat as security issues:

- The action or collector running or injecting commands, or reading data beyond what the README documents.
- The collector outliving its job on a persistent runner in a way that could be abused.
- Report or HTML output that lets untrusted content (step names, process or container names) run script when viewed.
- Supply-chain problems with released binaries or bundles, such as provenance mismatches or tampered `dist/`.

## What the action handles

For your own threat modelling:

- **Reads:** `/proc`, `/sys/fs/cgroup`, `statvfs` of `/` and the workspace, the Docker socket (a `GET /containers/<id>/json` request per new container, for its name and image), and `sudo -n dmesg` when passwordless sudo is allowed.
- **Writes:** only under `$RUNNER_TEMP/ci-telemetry/`, plus the job summary and the uploaded artifact.
- **Network:** in the `post` step only. One GitHub Actions API call with the provided token, and the artifact upload.
- **Artifact contents:** process command names (`comm`, ≤ 15 chars), container names and images, and resource figures. It never includes arguments, environment variables or file contents. The artifact is visible to anyone who can read the repository's Actions runs.

## Verifying what you run

Pin the action to a full commit SHA, and verify release binaries with:

```bash
gh attestation verify dist/bin/collector-linux-x64 --repo <owner>/ci-telemetry
```

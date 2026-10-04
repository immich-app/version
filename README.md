# version

Cloudflare Worker behind `version.immich.cloud`. It serves the latest Immich release to servers doing version checks, release changelogs, and the list of archived docs versions.

| Route                   | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `GET /version`          | Latest release for a channel (`?channel=stable` (default) or `?channel=rc`) |
| `GET /changelog`        | Release notes for `?version=` on a channel                                  |
| `GET /v1/docs/versions` | Docs versions with links to their `*.archive.immich.app` sites              |
| `POST /webhook`         | GitHub `release` webhook from `immich-app/immich` (HMAC-SHA256 verified)    |
| `GET /health`           | Health check                                                                |

Releases are stored in D1 and kept in sync by the release webhook and two crons: an incremental sync every 30 minutes and a full sync at 03:00 UTC.

## Development

```bash
pnpm install
pnpm run dev        # wrangler dev
pnpm run test       # vitest
pnpm run check      # tsc --noEmit
pnpm run lint
pnpm run format
pnpm run build      # bundles to dist/version/index.js
```

## Deployment

Infrastructure is managed with OpenTofu/Terragrunt in `deployment/`, and CI deploys it. To run Terragrunt locally (requires the 1Password CLI signed in to the immich account):

```bash
pnpm run build
cd deployment/modules/cloudflare/workers/version
ENVIRONMENT=dev TF_VAR_stage= mise run tg plan
```

This worker previously lived in [immich-app/services](https://github.com/immich-app/services). Commit messages that reference PRs from before the move link to that repository.

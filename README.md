# version

Cloudflare Worker that serves the latest release of each FUTO project it tracks, including Immich's to servers doing version checks, plus the list of archived Immich docs versions. This repository deploys a fresh instance to the FUTO Cloudflare account; the existing `version.immich.cloud` deployment still runs from [immich-app/services](https://github.com/immich-app/services) until traffic is migrated.

| Route                           | Description                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /v1/projects/{id}/version` | A project's latest release for a channel (`?channel=`, default the project's own)    |
| `GET /version`                  | Immich's latest release for a channel (`?channel=stable` (default) or `?channel=rc`) |
| `GET /v1/docs/versions`         | Immich docs versions with links to their `*.archive.immich.app` sites                |
| `POST /webhook`                 | GitHub `release` webhook, routed by repository (HMAC-SHA256 verified)                |
| `GET /health`                   | Health check                                                                         |

`/v1/projects/{id}/version` answers `{"project","channel","version","tag","published_at"}`, where `version` is the version in the tag (`3.3.0`) and `tag` the tag itself (`v3.3.0`). An unregistered id is a 404 `{"error":"Unknown project"}`, a channel the project lacks a 400 `{"error":"Invalid release channel","channels":[…]}`, and an empty channel a 404 `{"error":"No releases found"}`. It takes GET and HEAD, and a 200 may be cached for 5 minutes.

Releases are stored in D1 per project ([`projects.json`](projects.json); only Immich so far) and kept in sync by two crons that sync every project: an incremental sync every 30 minutes and a full sync at 03:00 UTC. A project's releases come from its GitHub repository or, read without a token, its public GitLab project. Immich's release webhook stores its releases as they are published; GitLab projects have no webhook.

## Development

```bash
pnpm install
pnpm run dev        # wrangler dev
pnpm run test       # vitest run
pnpm run validate:projects # check projects.json and its examples
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

The history of this worker was carried over from immich-app/services. Commit messages that reference PRs from before the move link to that repository.

## Observability

Metrics go to FUTO's o11y stack under `project=version`, and a series about one project carries its id as `version_project`. The Grafana dashboards, the alerts and the `version:*` recording rules are in [`o11y/`](o11y/README.md), published from `main` as a signed OCI bundle that o11y pulls.

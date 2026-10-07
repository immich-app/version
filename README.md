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

Releases are stored in D1 per project (see [Projects](#projects)) and kept in sync by two crons that sync every project: an incremental sync every 30 minutes and a full sync at 03:00 UTC. A project's releases come from its GitHub repository or, read without a token, its public GitLab project. Immich's release webhook stores its releases as they are published; GitLab projects have no webhook.

## Projects

[`projects.json`](projects.json) registers the projects the service tracks:

| Id           | Project                                                                         | Releases from                                                                                     |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `immich`     | [Immich](https://immich.app), also served by `/version` and `/v1/docs/versions` | GitHub, [immich-app/immich](https://github.com/immich-app/immich)                                 |
| `futo-notes` | FUTO Notes                                                                      | GitLab, [futo-notes/futo-notes](https://gitlab.futo.org/futo-notes/futo-notes) on gitlab.futo.org |

To onboard a project, open a PR that adds its entry. Editors check it against [`projects.schema.json`](projects.schema.json).

- `id`: a lowercase slug, `^[a-z][a-z0-9-]{1,31}$`. It is permanent: it is the URL segment, the D1 key and the `version_project` metric tag, so it can't be renamed or reused.
- `source`: where its releases come from. Only releases count, never bare tags.
  - A GitHub repository: `{ "type": "github-releases", "repo": "owner/name", "repoId": 123 }`, with the id from `gh api repos/owner/name --jq .id`. It is read through the service's own GitHub App, which must be installed on the owner with access to the repository; until it is, the project's syncs fail as `auth`. It is read by that id, which survives renames and transfers, so the id is what must be right.
  - A GitLab project: `{ "type": "gitlab-releases", "host": "gitlab.futo.org", "path": "group/name" }`. It is read without a token, so it must be public.
- `tags`: a `pattern` that matches the whole tag and captures the version in a group named `version`, and the `scheme` that parses it: `semver`, or `dotted` for one to four numbers such as `0.1.29.1`. A tag the pattern doesn't match isn't the project's.
- `channels`: each channel serves every stable release, plus the prereleases whose label it lists (`rc` takes both `-rc.2` and `-rc2`, `*` takes every prerelease). `{ "stable": [] }` serves stable releases only. `defaultChannel` is the one served when a request names none.
- `analytics`: `{ "clientIdentity": false }`. Putting client IPs and user agents on request metrics is a privacy decision that needs its own review.
- `examples`: real tags, each with the version and channels it must give, or `null` for a tag the project ignores. Pick the ones that are easy to get wrong: prereleases, one-off builds, and tags of other projects on the same source.

`pnpm run validate:projects` checks the entry and its examples, and CI runs it as "Validate projects.json". Once the PR is merged, `main` deploys dev, then prod. The next `*/30` sync fetches the project's releases in full (up to 300), and each one after lists the newest 20, so a new release is served within 30 minutes. Then check `https://version.dev.futo.cloud/v1/projects/{id}/version`, and the same path on `version.futo.cloud`. A sync that keeps failing fires the `version-project-sync-failing` alert, and new releases whose tags the pattern doesn't match fire `version-project-tags-skipped` ([`o11y/`](o11y/README.md)).

Versions are ordered by the scheme, never by release date: FUTO Notes released v1.4.0 a month after v1.4.1, and v1.4.1 is still the newer one. Removing an entry stops its syncs and its route; its stored releases stay in D1, unserved.

To try an entry before it is merged, run its sync locally against a local D1. Without the GitHub App's bindings, GitHub is read unauthenticated, at 60 requests an hour.

```bash
pnpm exec wrangler d1 migrations apply VERSION_DB --local
pnpm exec wrangler dev --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=*/30+*+*+*+*'
curl http://localhost:8787/v1/projects/{id}/version
```

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

GitHub releases are read through the version service's own GitHub App, owned by immich-app and public so other owners can install it (Metadata and Contents: read, no webhook). Its credentials come from 1Password (`GITHUB_APP_IMMICH_VERSION`, mirrored by core-infra-tf), and the worker finds the app's installation on each repository's owner. The `release` webhook on immich-app/immich is managed through the Immich Tofu app.

The history of this worker was carried over from immich-app/services. Commit messages that reference PRs from before the move link to that repository.

## Observability

Metrics go to FUTO's o11y stack under `project=version`, and a series about one project carries its id as `version_project`. The Grafana dashboards, the alerts and the `version:*` recording rules are in [`o11y/`](o11y/README.md), published from `main` as a signed OCI bundle that o11y pulls.

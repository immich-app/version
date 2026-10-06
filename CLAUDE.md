# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The `version` Cloudflare Worker. It serves the latest Immich release (`/version`) and the archived docs versions list (`/v1/docs/versions`). Releases are stored in D1 and synced from `immich-app/immich` via a GitHub `release` webhook (`/webhook`) and crons. It was extracted from the `immich-app/services` monorepo with its history.

This repo deploys a fresh instance to the FUTO Cloudflare account. The existing `version.immich.cloud` deployment is still managed from `immich-app/services` and is migrated to this one later; nothing here touches it.

## Common Commands

```bash
pnpm install
pnpm run dev        # wrangler dev
pnpm run test       # vitest run (via @cloudflare/vitest-plugin); test:watch for watch mode
pnpm run validate:projects # projects.json's validator and examples (src/projects.test.ts)
pnpm run check      # tsc --noEmit
pnpm run lint       # eslint . --max-warnings 0
pnpm run format     # prettier --check .
pnpm run build      # wrangler deploy --dry-run --outdir dist/version
```

## Layout

```
src/                      # worker source and tests
projects.json             # the project registry (see Projects); projects.schema.json describes it for editors
migrations/               # D1 migrations, applied by Terraform (d1.tf)
o11y/                     # dashboards, alerts and recording rules shipped to FUTO o11y (o11y/README.md)
wrangler.toml             # local dev / dry-run build config only
worker-configuration.d.ts # hand-edited wrangler types; do not blindly regenerate
deployment/
├── state.hcl             # shared Terragrunt remote state config
├── .env                  # op:// references resolved by `mise run tg`
└── modules/cloudflare/workers/version/
```

## Testing

Tests run in the Workers runtime through `@cloudflare/vitest-plugin`. They import `env` and `exports` from `cloudflare:workers`. `vitest.config.ts` reads `migrations/`, and `src/test/setup.ts` applies those files before every test file, the same way `d1.tf` does. `src/migrations.test.ts` seeds a row into every table, replays the migrations twice, and expects the schema and data to be unchanged.

### Migrations

`d1.tf` has no ledger. Whenever a migration file changes, and on every retry, it re-runs **every** file against the live database. A file stops at its first failing statement, and only "already exists" and "duplicate column" errors are tolerated. So every migration must be safe to re-run:

- Use `CREATE TABLE/INDEX IF NOT EXISTS` and `DROP … IF EXISTS`.
- `ALTER TABLE … ADD` goes last in its file, because its replay error stops the file.
- No data copies, table rebuilds or `INSERT`s. Those need a real migration ledger first.

The replay test fails on anything that errors, or that changes the schema or any row when re-run. Give every new table a seed row in `SEEDS` (`src/migrations.test.ts`); a test fails if one is missing.

## Projects

`projects.json` registers the projects whose releases the service tracks. Only Immich is registered, and nothing reads the registry at runtime yet. `src/projects.ts` validates it, compiles its tag patterns and provides `normalize(project, tag)`. `src/version-schemes.ts` parses and orders versions.

- An id (`^[a-z][a-z0-9-]{1,31}$`) is permanent: it is the URL segment, the D1 key and the `version_project` metric tag.
- `tags.pattern` must match the whole tag and capture the version in a group named `version`, which `tags.scheme` (`semver` or `dotted`) parses. Any other tag is not the project's.
- A channel serves every stable release, plus the prereleases whose label it lists (`*` lists them all). The label is the first prerelease identifier's leading letters, lowercased, so `rc.2` and `rc1` are both `rc`. A prerelease no channel lists is never served.
- Versions are ordered by their scheme, not by release date. Identifiers of letters then digits compare numerically (`rc2` < `rc10`), unlike plain semver.
- `examples` maps real tags to the version and channels they must normalize to, or `null` for a tag the project ignores. `src/projects.test.ts` checks every one, and CI runs it as its own "Validate projects.json" step.
- `projects.schema.json` is only for editors; the validator in `src/projects.ts` is the check that counts. A test keeps their ids, schemes and source types in step.
- `analytics.clientIdentity` puts client IPs and user agents on request metrics. Only the projects in the test's `CLIENT_IDENTITY_PROJECTS` may set it.

## Deployment

- The Cloudflare account ID and the `version_deploy` API token come from the `prod_cloudflare_futo_api_keys` remote state, which core-infra-tf manages.
- The zone is set once in `terragrunt.hcl` (`zone_name`). The worker is served at `version.<zone>`, `version.dev.<zone>` and `version.pr-<N>.dev.<zone>`.
- The state schema is `cloudflare_workers_futo_version_${env}${stage}`. It doesn't depend on the zone, so changing `zone_name` only moves the custom domain and the release webhook URL.
- Prod and dev each manage a `release` webhook on `immich-app/immich` (`webhook.tf`, via the Immich Tofu GitHub App) that posts to `/webhook`, signed with the `GITHUB_WEBHOOK_SECRET` binding. PR stages get no hook and rely on the sync crons.
- CI deploys with `mise run tf:apply` from `deployment/`. PRs deploy a `pr-<N>` stage to dev, and `main` deploys dev and prod. The Build workflow can also be run by hand (workflow_dispatch); on `main` that redeploys dev and prod.
- Build runs the Test workflow (`workflow_call`) and every deploy waits for it. On `main`, prod also waits for dev to apply and pass `deployment/scripts/smoke-test.sh` (`/health` is exactly 200 with `{"status":"ok"}`, and `/version` is 200 or the 404 for an empty table, not a missing route), and prod runs the same script after its own apply. `deployment/scripts/smoke-test.test.sh` tests that gate against a stub `curl` in the Test workflow.
- The worker version `depends_on` the D1 migrations, so new code never goes live before its schema.
- Terraform reads the bundle from `${dist_dir}/version/index.js` and the migrations from `migrations_dir`, so the build must output to `dist/version/`.
- `compatibility_date` and the cron expressions are duplicated in `wrangler.toml` and `worker.tf`, and must match. The full-sync cron is detected by string equality on `0 3 * * *` in `src/index.ts`.

## Metrics

Metrics go to the FUTO o11y stack through its vmauth gateway (`METRICS_URL` / `METRICS_TOKEN` bindings, Influx line protocol). Prod ships to the production store and dev main to the staging one. PR stages never ship: `worker.tf` binds `METRICS_URL` / `METRICS_TOKEN` only when `stage` is empty, because a PR stage would write the same `env=dev` series as dev main.

- The token comes from `deployment/.env` (`op://tf_$ENVIRONMENT/O11Y_VICTORIAMETRICS_VMAUTH_PASSWORD`). Dev main and prod can't turn shipping off: a precondition fails their plan without a token, because the o11y bundle's heartbeat alert would page for the missing metrics. A reference that does not resolve makes `op run` fail every deploy and teardown.
- The token is FUTO's, mirrored into immich's `tf_dev` / `tf_prod` by core-infra-tf and baked in at deploy time. After a FUTO rotation, apply core-infra-tf, then dispatch the Build workflow on `main`.
- A worker that doesn't ship (`wrangler dev`, tests, PR stages) logs its line protocol instead. A shipping worker never logs it, so client IPs stay out of Workers Logs.
- `InfluxMetricsProvider` stamps the five o11y identity labels on every line, after the metric's own tags so they always win: `project`, `cluster`, `provider` and `region` come from the `METRICS_*` bindings in `worker.tf`, and `env` comes from `ENVIRONMENT`. `project=version, cluster=version` is o11y's tenant key, so don't change either value without changing the o11y tenant registry.
- The per-request tags `client_ip`, `user_agent`, `asOrg`, `continent` and `colo` are kept on purpose: the recording rules count unique servers from them.
- `http_response`'s `method` and `path` tags are limited to the worker's own methods and routes, with `other` for anything else, so scanners can't create a series per request in the shared store.
- Tag values have backslashes escaped before influxdb-client sees them, because a trailing one makes vminsert reject the whole batch.
- The store deduplicates samples per series within 20s, so per-request counters under-count there.
- Dashboards, alerts and the `version:*` recording rules live in `o11y/` and ship as a signed OCI bundle. See `o11y/README.md`. Check the bundle with `MISE_ENV=o11y mise run o11y:render`; its tools are in `.mise/config.o11y.toml`, so the deploy jobs don't install them.

## Conventions

- Conventional commits, squash-merged PRs.
- All responses include `Access-Control-Allow-Origin: *`.

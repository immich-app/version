# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The `version` Cloudflare Worker. It serves the latest Immich release (`/version`), release changelogs (`/changelog`), and the archived docs versions list (`/v1/docs/versions`). Releases are stored in D1 and synced from `immich-app/immich` via a GitHub `release` webhook (`/webhook`) and crons. It was extracted from the `immich-app/services` monorepo with its history.

This repo deploys a fresh instance to the FUTO Cloudflare account. The existing `version.immich.cloud` deployment is still managed from `immich-app/services` and is migrated to this one later; nothing here touches it.

## Common Commands

```bash
pnpm install
pnpm run dev        # wrangler dev
pnpm run test       # vitest run (via @cloudflare/vitest-plugin); test:watch for watch mode
pnpm run check      # tsc --noEmit
pnpm run lint       # eslint . --max-warnings 0
pnpm run format     # prettier --check .
pnpm run build      # wrangler deploy --dry-run --outdir dist/version
```

## Layout

```
src/                      # worker source and tests
migrations/               # D1 migrations, applied by Terraform (d1.tf)
wrangler.toml             # local dev / dry-run build config only
worker-configuration.d.ts # hand-edited wrangler types; do not blindly regenerate
deployment/
├── state.hcl             # shared Terragrunt remote state config
├── .env                  # op:// references resolved by `mise run tg`
└── modules/cloudflare/workers/version/
```

## Testing

Tests run in the Workers runtime through `@cloudflare/vitest-plugin`. They import `env` and `exports` from `cloudflare:workers`, and create the D1 schema inline in `src/index.test.ts` rather than from `migrations/`. Keep the two in sync when changing the schema.

## Deployment

- The Cloudflare account ID and the `version_deploy` API token come from the `prod_cloudflare_futo_api_keys` remote state, which core-infra-tf manages.
- The zone is set once in `terragrunt.hcl` (`zone_name`). The worker is served at `version.<zone>`, `version.dev.<zone>` and `version.pr-<N>.dev.<zone>`.
- The state schema is `cloudflare_workers_<zone>_version_${env}${stage}`, derived from the zone, so changing the zone after the first apply points at an empty state.
- Prod and dev each manage a `release` webhook on `immich-app/immich` (`webhook.tf`, via the Immich Tofu GitHub App) that posts to `/webhook`, signed with the `GITHUB_WEBHOOK_SECRET` binding. PR stages get no hook and rely on the sync crons.
- CI deploys with `mise run tf:apply` from `deployment/`. PRs deploy a `pr-<N>` stage to dev, and `main` deploys dev and prod.
- Terraform reads the bundle from `${dist_dir}/version/index.js` and the migrations from `migrations_dir`, so the build must output to `dist/version/`.
- `compatibility_date` and the cron expressions are duplicated in `wrangler.toml` and `worker.tf`, and must match. The full-sync cron is detected by string equality on `0 3 * * *` in `src/index.ts`.

## Metrics

Metrics go to the FUTO o11y stack through its vmauth gateway (`METRICS_URL` / `METRICS_TOKEN` bindings, Influx line protocol). They are only shipped once `TF_VAR_o11y_vmauth_token` is set in `deployment/.env`. Before enabling them, the metrics need the o11y identity labels (`project`, `env`, `cluster`, `provider`, `region`) and must drop per-request high-cardinality tags (`client_ip`, `user_agent`, `asOrg`). The store deduplicates samples per series within 20s, so per-request counters under-count there.

## Conventions

- Conventional commits, squash-merged PRs.
- All responses include `Access-Control-Allow-Origin: *`.

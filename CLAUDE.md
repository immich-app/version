# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The `version` Cloudflare Worker (`version.immich.cloud`). It serves the latest Immich release (`/version`), release changelogs (`/changelog`), and the archived docs versions list (`/v1/docs/versions`). Releases are stored in D1 and synced from `immich-app/immich` via a GitHub `release` webhook (`/webhook`) and crons. It was extracted from the `immich-app/services` monorepo with its history.

## Common Commands

```bash
pnpm install
pnpm run dev        # wrangler dev
pnpm run test       # vitest (via @cloudflare/vitest-plugin)
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

- CI deploys with `mise run tf:apply` from `deployment/`. PRs deploy a `pr-<N>` stage to dev, and `main` deploys dev and prod.
- Terraform reads the bundle from `${dist_dir}/version/index.js` and the migrations from `migrations_dir`, so the build must output to `dist/version/`.
- The state schema is `services_cf_workers_version_${env}${stage}`. The `services_` prefix is left over from the monorepo; do not change it without migrating state.
- `compatibility_date` and the cron expressions are duplicated in `wrangler.toml` and `worker.tf`, and must match. The full-sync cron is detected by string equality on `0 3 * * *` in `src/index.ts`.
- Metric names (prefix `version_`) and their tags feed recording rules in `immich-app/devtools`. Renaming them breaks dashboards.

## Conventions

- Conventional commits, squash-merged PRs.
- All responses include `Access-Control-Allow-Origin: *`.

import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import worker from '../index.js';

export interface SeedRelease {
  id: number;
  tag_name: string;
  published_at?: string;
}

export async function insertRelease(release: SeedRelease, project = 'immich') {
  await env.VERSION_DB.prepare(
    `INSERT OR REPLACE INTO project_releases (project, tag, published_at, source_id, forge_prerelease, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, '2025-01-01T00:00:00Z')`,
  )
    .bind(
      project,
      release.tag_name,
      release.published_at ?? '',
      String(release.id),
      Number(release.tag_name.includes('-')),
    )
    .run();
}

export async function clearReleases() {
  await env.VERSION_DB.exec('DELETE FROM project_releases');
  await env.VERSION_DB.exec('DELETE FROM project_sync_state');
}

export async function storedReleases(project = 'immich') {
  const { results } = await env.VERSION_DB.prepare(
    'SELECT tag, published_at, source_id, forge_prerelease, synced_at FROM project_releases WHERE project = ?1 ORDER BY tag',
  )
    .bind(project)
    .all<{
      tag: string;
      published_at: string;
      source_id: string;
      forge_prerelease: number | null;
      synced_at: string;
    }>();
  return results;
}

export async function storedTags(project = 'immich') {
  const releases = await storedReleases(project);
  return releases.map(({ tag }) => tag);
}

export async function fullSyncedAt(project = 'immich') {
  const row = await env.VERSION_DB.prepare('SELECT full_synced_at FROM project_sync_state WHERE project = ?1')
    .bind(project)
    .first<{ full_synced_at: string | null }>();
  return row?.full_synced_at ?? null;
}

// Tests ship nothing (no METRICS_URL), so InfluxMetricsProvider logs its lines instead.
export async function loggedLines(run: () => Promise<unknown>): Promise<string[]> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await run();
    return logSpy.mock.calls.flatMap(([body]) => String(body).split('\n')).filter((l) => l.startsWith('version_'));
  } finally {
    logSpy.mockRestore();
  }
}

const IDENTITY_LABELS = new Set(['project', 'env', 'cluster', 'provider', 'region']);
const unescape = (value: string) => value.replaceAll(/\\(.)/g, '$1');

// Each logged series' own tags, without the identity labels, by measurement.
export function seriesTags(lines: string[]): Record<string, Record<string, string>[]> {
  const series: Record<string, Record<string, string>[]> = {};
  for (const line of lines) {
    // Line protocol escapes spaces, commas and equals signs with a backslash.
    const [name, ...pairs] = /^(?:\\.|[^\\ ])*/.exec(line)![0].match(/(?:\\.|[^\\,])+/g)!;
    const tags = pairs
      .map((pair) => /^((?:\\.|[^\\=])*)=(.*)$/.exec(pair)!)
      .filter(([, key]) => !IDENTITY_LABELS.has(key))
      .map(([, key, value]) => [unescape(key), unescape(value)]);
    (series[name] ??= []).push(Object.fromEntries(tags));
  }
  return series;
}

// A request through LHR, as Cloudflare would describe it.
export const EDGE = { cf: { continent: 'EU', colo: 'LHR', asOrganization: 'Example AS' } } as RequestInit;

export async function createWebhookSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

// The repository a GitHub delivery from immich-app/immich names.
export const IMMICH_REPOSITORY = { id: 455_229_168, full_name: 'immich-app/immich' };

type FetchHandler = { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

// Calls a worker's fetch handler directly, as Cloudflare would, and waits for what it deferred.
export async function fetchFrom(handler: FetchHandler, url: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await handler.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Posts a signed `published` release delivery from `repository`, as GitHub
 * would. The secret is wrangler.toml's GITHUB_WEBHOOK_SECRET. Goes through
 * the worker's own entrypoint, or through `handler` when given.
 */
export async function publishRelease(
  release: Record<string, unknown>,
  { repository = IMMICH_REPOSITORY as unknown, init = {}, handler = undefined as FetchHandler | undefined } = {},
) {
  const body = JSON.stringify({ action: 'published', release, repository });
  const request = {
    ...init,
    method: 'POST',
    body,
    headers: {
      'X-Hub-Signature-256': await createWebhookSignature(body, 'test-secret'),
      'X-GitHub-Event': 'release',
    },
  };
  return handler
    ? await fetchFrom(handler, 'https://example.com/webhook', request)
    : await exports.default.fetch('https://example.com/webhook', request);
}

type ScheduledHandler = { scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> };

// Runs a worker's scheduled handler for a cron expression and waits for what it deferred.
export async function runCron(cron: string, { handler = worker as ScheduledHandler, bindings = env } = {}) {
  const ctx = createExecutionContext();
  await handler.scheduled(createScheduledController({ cron }), bindings, ctx);
  await waitOnExecutionContext(ctx);
}

/**
 * Answers a GitLab releases listing the way GitLab's offset pagination does:
 * `per_page` (default 20) of `releases` from `page` (default 1), in the order
 * given, with the next page's number in x-next-page, left empty on the last.
 */
export function gitlabReleasesPage(url: string, releases: readonly unknown[]): Response {
  const { searchParams } = new URL(url);
  const perPage = Number(searchParams.get('per_page') ?? 20);
  const page = Number(searchParams.get('page') ?? 1);
  const last = page * perPage >= releases.length;
  return Response.json(releases.slice((page - 1) * perPage, page * perPage), {
    headers: {
      'x-page': String(page),
      'x-per-page': String(perPage),
      'x-total': String(releases.length),
      'x-next-page': last ? '' : String(page + 1),
    },
  });
}

import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubRepository, toProjectRelease } from './github-repository.js';
import worker from './index.js';
import { MemoryCache } from './memory-cache.js';
import type { DocsVersion, VersionResponse } from './types.js';
import { versionCaches } from './version-service.js';
import { verifyWebhookSignature } from './webhook.js';

const mockReleases = [
  { id: 3, tag_name: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' },
  { id: 2, tag_name: 'v1.110.0', published_at: '2025-02-01T00:00:00Z' },
  { id: 1, tag_name: 'v1.100.0', published_at: '2025-01-01T00:00:00Z' },
];

interface SeedRelease {
  id: number;
  tag_name: string;
  published_at?: string;
}

async function insertRelease(release: SeedRelease, project = 'immich') {
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

async function clearReleases() {
  await env.VERSION_DB.exec('DELETE FROM project_releases');
  await env.VERSION_DB.exec('DELETE FROM project_sync_state');
}

async function storedReleases(project = 'immich') {
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

async function fullSyncedAt(project = 'immich') {
  const row = await env.VERSION_DB.prepare('SELECT full_synced_at FROM project_sync_state WHERE project = ?1')
    .bind(project)
    .first<{ full_synced_at: string | null }>();
  return row?.full_synced_at ?? null;
}

// Stores a cached /version answer for Immich that is already stale.
function setStaleCache(tag: string, published_at: string) {
  const { cache } = versionCaches.get('immich');
  cache.set(
    new Map([
      ['stable', { tag, version: tag.replace(/^v/, ''), published_at }],
      ['rc', null],
    ]),
  );
  Object.assign(cache, { expiresAt: 0 });
}

async function seedReleases() {
  for (const release of mockReleases) {
    await insertRelease(release);
  }
}

async function fetchVersion(channel?: string): Promise<VersionResponse> {
  const query = channel === undefined ? '' : `?channel=${channel}`;
  const response = await exports.default.fetch(`https://example.com/version${query}`);
  expect(response.status).toBe(200);
  return await response.json();
}

async function fetchDocsVersions(): Promise<DocsVersion[]> {
  const response = await exports.default.fetch('https://example.com/v1/docs/versions');
  expect(response.status).toBe(200);
  return await response.json();
}

// Tests ship nothing (no METRICS_URL), so InfluxMetricsProvider logs its lines instead.
async function httpResponseLine(url: string, init?: RequestInit) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await exports.default.fetch(url, init);
    const lines = logSpy.mock.calls.flatMap(([body]) => String(body).split('\n'));
    const line = lines.find((l) => l.startsWith('version_http_response,'));
    expect(line).toBeDefined();
    return line!;
  } finally {
    logSpy.mockRestore();
  }
}

async function createWebhookSignature(body: string, secret: string): Promise<string> {
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

// Posts a signed `published` release delivery, as GitHub would. The secret is
// wrangler.toml's GITHUB_WEBHOOK_SECRET.
async function publishRelease(release: Record<string, unknown>) {
  const body = JSON.stringify({ action: 'published', release });
  return await exports.default.fetch('https://example.com/webhook', {
    method: 'POST',
    body,
    headers: {
      'X-Hub-Signature-256': await createWebhookSignature(body, 'test-secret'),
      'X-GitHub-Event': 'release',
    },
  });
}

// Runs the scheduled handler for a cron expression and waits for what it deferred.
async function runCron(cron: string) {
  const waiting: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waiting.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  await worker.scheduled({ cron, scheduledTime: Date.now() } as ScheduledEvent, env, ctx);
  await Promise.all(waiting);
}

describe('MemoryCache', () => {
  it('returns null when empty', () => {
    const cache = new MemoryCache<string>(1000);
    expect(cache.get()).toBeNull();
  });

  it('stores and retrieves a fresh value', () => {
    const cache = new MemoryCache<string>(1000);
    cache.set('hello');
    const result = cache.get();
    expect(result).not.toBeNull();
    expect(result!.value).toBe('hello');
    expect(result!.stale).toBe(false);
  });

  it('returns stale after TTL expires', () => {
    const cache = new MemoryCache<string>(0); // 0ms TTL = immediately stale
    cache.set('hello');
    const result = cache.get();
    expect(result).not.toBeNull();
    expect(result!.value).toBe('hello');
    expect(result!.stale).toBe(true);
  });

  it('invalidates the cache', () => {
    const cache = new MemoryCache<string>(1000);
    cache.set('hello');
    cache.invalidate();
    expect(cache.get()).toBeNull();
  });
});

describe('Webhook signature verification', () => {
  it('verifies a valid signature', async () => {
    const body = 'test body';
    const secret = 'test-secret';
    const signature = await createWebhookSignature(body, secret);
    expect(await verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    expect(await verifyWebhookSignature('body', 'sha256=invalid', 'secret')).toBe(false);
  });

  it('rejects a signature without sha256 prefix', async () => {
    expect(await verifyWebhookSignature('body', 'md5=abc', 'secret')).toBe(false);
  });

  it('rejects when body is tampered', async () => {
    const signature = await createWebhookSignature('original', 'secret');
    expect(await verifyWebhookSignature('tampered', signature, 'secret')).toBe(false);
  });
});

describe('Version Worker', () => {
  beforeEach(async () => {
    versionCaches.clear();
    await clearReleases();
    await seedReleases();
  });

  describe('OPTIONS preflight', () => {
    it('returns correct CORS headers', async () => {
      const response = await exports.default.fetch('https://example.com/version', { method: 'OPTIONS' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    });
  });

  describe('GET /health', () => {
    it('returns healthy status', async () => {
      const response = await exports.default.fetch('https://example.com/health');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /version', () => {
    it('returns the latest version', async () => {
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');
      expect(body.published_at).toBe('2025-03-01T00:00:00Z');
    });

    it('returns the latest stable version, ignoring newer pre-releases', async () => {
      // A pre-release newer than every stable release must not be served on the default (stable) channel.
      await insertRelease({ id: 10, tag_name: 'v1.130.0-rc.1', published_at: '2025-04-01T00:00:00Z' });
      versionCaches.invalidate('immich');

      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');
    });

    it('awaits D1 on cold start rather than deferring', async () => {
      // Cache is empty (invalidated in beforeEach), D1 has data
      // The first request must return real data, not 404 or empty
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.version).toBe('v1.120.0');

      // Now delete D1 data — second request should come from cache, proving
      // the first request populated the cache synchronously
      await clearReleases();
      const second = await exports.default.fetch('https://example.com/version');
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as any;
      expect(secondBody.version).toBe('v1.120.0');
    });

    it('does not include Cache-Control header (memory cached, not CDN)', async () => {
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.headers.get('Cache-Control')).toBeNull();
    });

    it('returns 404 when no releases exist', async () => {
      await clearReleases();
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.status).toBe(404);
    });

    it('serves from in-memory cache on second request', async () => {
      const first = await exports.default.fetch('https://example.com/version');
      expect(first.status).toBe(200);

      // Delete from D1 - second request should still work from cache
      await clearReleases();

      const second = await exports.default.fetch('https://example.com/version');
      expect(second.status).toBe(200);
      const body = (await second.json()) as any;
      expect(body.version).toBe('v1.120.0');
    });

    it('includes CORS header', async () => {
      const response = await exports.default.fetch('https://example.com/version');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('serves stale data while revalidating in the background', async () => {
      // Prime the cache
      const first = await exports.default.fetch('https://example.com/version');
      expect(first.status).toBe(200);

      // Expire the cache
      setStaleCache('v1.120.0', '2025-03-01T00:00:00Z');

      // Update D1 with a new version
      await insertRelease({ id: 4, tag_name: 'v1.130.0', published_at: '2025-04-01T00:00:00Z' });

      // This request should get stale v1.120.0 while triggering background refresh
      const stale = await exports.default.fetch('https://example.com/version');
      expect(stale.status).toBe(200);
      const staleBody = (await stale.json()) as any;
      expect(staleBody.version).toBe('v1.120.0');

      // Wait for background refresh to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Next request should get the updated version from refreshed cache
      const fresh = await exports.default.fetch('https://example.com/version');
      expect(fresh.status).toBe(200);
      const freshBody = (await fresh.json()) as any;
      expect(freshBody.version).toBe('v1.130.0');
    });

    it('deduplicates concurrent revalidation requests', async () => {
      // Set up stale cache
      setStaleCache('v1.120.0', '2025-03-01T00:00:00Z');

      expect(versionCaches.get('immich').revalidating).toBe(false);

      // Fire two concurrent requests while stale
      const [r1, r2] = await Promise.all([
        exports.default.fetch('https://example.com/version'),
        exports.default.fetch('https://example.com/version'),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Both should return stale data immediately
      const b1 = (await r1.json()) as any;
      const b2 = (await r2.json()) as any;
      expect(b1.version).toBe('v1.120.0');
      expect(b2.version).toBe('v1.120.0');
    });
  });

  describe('GET /version - release channels', () => {
    it('returns 400 for an invalid channel', async () => {
      const response = await exports.default.fetch('https://example.com/version?channel=nightly');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid release channel. Expected "stable" or "rc"' });
    });

    it('defaults to the stable channel when none is provided', async () => {
      await insertRelease({ id: 20, tag_name: 'v1.121.0-rc.1' });

      const latest = await fetchVersion();
      expect(latest.version).toBe('v1.120.0');
      expect(await fetchVersion('stable')).toEqual(latest);
    });

    it('includes pre-releases on the rc channel but excludes them on stable', async () => {
      await insertRelease({ id: 20, tag_name: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z' });

      expect(await fetchVersion('rc')).toEqual({ version: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z' });
      expect(await fetchVersion('stable')).toEqual({ version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' });
    });

    it('treats a stable release as newer than its own pre-release on the rc channel', async () => {
      await insertRelease({ id: 21, tag_name: 'v1.121.0-rc.1' });
      await insertRelease({ id: 22, tag_name: 'v1.121.0' });

      // Stable 1.121.0 outranks 1.121.0-rc.1 in semver.
      expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0' });
    });

    it('reports the stable as rc-channel latest once it supersedes the pre-release', async () => {
      // Once 3.0.0 ships, an rc-channel client must see 3.0.0 rather than 3.0.0-rc.2.
      await insertRelease({ id: 30, tag_name: 'v3.0.0-rc.2', published_at: '2025-01-01T00:00:00Z' });
      await insertRelease({ id: 31, tag_name: 'v3.0.0', published_at: '2025-02-01T00:00:00Z' });

      expect(await fetchVersion('rc')).toEqual({ version: 'v3.0.0', published_at: '2025-02-01T00:00:00Z' });
    });

    it('orders rc-channel latest by semver precedence, not publish date', async () => {
      // 2.8.1 is a patch to an older line, published *after* 3.0.0-rc.2. The rc channel must still
      // report 3.0.0-rc.2 as latest because it is the highest semver, not the most recently published.
      await insertRelease({ id: 32, tag_name: 'v3.0.0-rc.2', published_at: '2025-01-01T00:00:00Z' });
      await insertRelease({ id: 33, tag_name: 'v2.8.1', published_at: '2025-06-01T00:00:00Z' });

      expect(await fetchVersion('rc')).toMatchObject({ version: 'v3.0.0-rc.2' });
      expect(await fetchVersion('stable')).toMatchObject({ version: 'v2.8.1' });
    });

    it('orders pre-releases of the same version by their number', async () => {
      // Stored newest first, so the order can't come from the rows.
      await insertRelease({ id: 24, tag_name: 'v1.121.0-rc.2' });
      await insertRelease({ id: 23, tag_name: 'v1.121.0-rc.1' });

      expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.2' });
    });

    it('compares pre-release numbers numerically', async () => {
      await insertRelease({ id: 25, tag_name: 'v1.121.0-rc.9' });
      await insertRelease({ id: 26, tag_name: 'v1.121.0-rc.10' });

      expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.10' });
    });

    it("never serves a stored tag Immich's pattern rejects, such as -rc1", async () => {
      await insertRelease({ id: 27, tag_name: 'v1.130.0-rc1' });
      await insertRelease({ id: 28, tag_name: 'v1.130.0-beta.1' });

      expect(await fetchVersion('stable')).toMatchObject({ version: 'v1.120.0' });
      expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.120.0' });
    });

    it("ignores another project's releases", async () => {
      await insertRelease({ id: 29, tag_name: 'v9.0.0', published_at: '2025-05-01T00:00:00Z' }, 'futo-notes');
      await insertRelease({ id: 30, tag_name: 'v1.120.0', published_at: '2025-05-01T00:00:00Z' }, 'futo-notes');

      expect(await fetchVersion('stable')).toEqual({ version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' });
    });

    it('answers an empty channel from memory after the first read', async () => {
      await clearReleases();
      await insertRelease({ id: 20, tag_name: 'v1.121.0-rc.1' });
      const first = await exports.default.fetch('https://example.com/version?channel=stable');
      expect(first.status).toBe(404);

      // That read cached stable as empty, so a release stored since isn't read
      // until the cache expires.
      await insertRelease({ id: 3, tag_name: 'v1.120.0' });
      const second = await exports.default.fetch('https://example.com/version?channel=stable');
      expect(second.status).toBe(404);
      expect(second.headers.get('Server-Timing')).not.toContain('d1_get_latest');
      expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.1' });
    });
  });

  describe('POST /webhook', () => {
    const webhookSecret = 'test-secret';

    it('returns 401 without signature', async () => {
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(401);
    });

    it('returns 401 with invalid signature', async () => {
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'X-Hub-Signature-256': 'sha256=invalid' },
      });
      expect(response.status).toBe(401);
    });

    it('returns 405 for non-POST requests', async () => {
      const response = await exports.default.fetch('https://example.com/webhook');
      expect(response.status).toBe(405);
    });

    it('ignores non-release events', async () => {
      const body = JSON.stringify({ action: 'opened' });
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'pull_request',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });

    it('ignores non-published release actions', async () => {
      const body = JSON.stringify({ action: 'created', release: {} });
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });

    it('upserts a published release and invalidates cache', async () => {
      // Prime the cache
      await exports.default.fetch('https://example.com/version');

      const releasePayload = {
        action: 'published',
        release: {
          id: 4,
          tag_name: 'v1.130.0',
          name: 'v1.130.0',
          url: 'https://api.github.com/repos/immich-app/immich/releases/4',
          body: 'New release',
          created_at: '2025-04-01T00:00:00Z',
          published_at: '2025-04-01T00:00:00Z',
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.success).toBe(true);

      // Verify the new release is now the latest (cache was invalidated)
      const versionResponse = await exports.default.fetch('https://example.com/version');
      const versionBody = (await versionResponse.json()) as any;
      expect(versionBody.version).toBe('v1.130.0');
    });

    it('updates an existing release in place', async () => {
      const releasePayload = {
        action: 'published',
        release: {
          id: 3,
          tag_name: 'v1.120.0',
          name: 'v1.120.0',
          url: 'https://api.github.com/repos/immich-app/immich/releases/3',
          body: 'Updated release notes',
          created_at: '2025-03-01T00:00:00Z',
          published_at: '2025-03-02T00:00:00Z',
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });

      expect(await fetchVersion()).toEqual({ version: 'v1.120.0', published_at: '2025-03-02T00:00:00Z' });
      expect(await storedReleases()).toHaveLength(mockReleases.length);
    });

    it('returns 400 for invalid release payload', async () => {
      const releasePayload = {
        action: 'published',
        release: { no_id: true },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(400);
    });

    it('ignores draft releases', async () => {
      const releasePayload = {
        action: 'published',
        release: {
          id: 5,
          tag_name: 'v1.140.0',
          name: 'v1.140.0',
          url: '',
          body: '',
          created_at: '',
          published_at: '',
          draft: true,
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.ignored).toBe(true);
    });

    it('stores prerelease releases for the rc channel', async () => {
      const releasePayload = {
        action: 'published',
        release: {
          id: 6,
          tag_name: 'v1.121.0-rc.1',
          name: 'v1.121.0-rc.1',
          url: '',
          body: 'Release candidate',
          created_at: '2025-03-15T00:00:00Z',
          published_at: '2025-03-15T00:00:00Z',
          prerelease: true,
        },
      };

      const body = JSON.stringify(releasePayload);
      const signature = await createWebhookSignature(body, webhookSecret);
      const response = await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'release',
        },
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.success).toBe(true);

      // The rc build is served on the rc channel...
      expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.1' });

      // ...but hidden from the stable channel.
      expect(await fetchVersion('stable')).toMatchObject({ version: 'v1.120.0' });

      // GitHub's own prerelease flag and release id are kept with the row.
      expect(await storedReleases()).toContainEqual(
        expect.objectContaining({ tag: 'v1.121.0-rc.1', source_id: '6', forge_prerelease: 1 }),
      );
    });

    it.each(['v1.130.0-rc1', 'v1.130.0-dev', 'nightly'])(
      "accepts a release tagged %s, which isn't Immich's, but stores nothing",
      async (tag) => {
        const response = await publishRelease({ id: 7, tag_name: tag, published_at: '2025-04-01T00:00:00Z' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true });
        const stored = await storedReleases();
        expect(stored.map((release) => release.tag)).not.toContain(tag);
        expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.120.0' });
      },
    );

    it('never marks the project as fully synced', async () => {
      await publishRelease({ id: 8, tag_name: 'v1.130.0', published_at: '2025-04-01T00:00:00Z' });

      expect(await storedReleases()).toContainEqual(expect.objectContaining({ tag: 'v1.130.0' }));
      expect(await fullSyncedAt()).toBeNull();
    });
  });

  describe('GET /v1/docs/versions', () => {
    it('returns the seeded releases newest first', async () => {
      expect(await fetchDocsVersions()).toEqual([
        { label: 'v1.120.0', url: 'https://v1.120.0.archive.immich.app', rootPath: '/docs' },
        { label: 'v1.110.0', url: 'https://v1.110.0.archive.immich.app', rootPath: '/docs' },
        { label: 'v1.100.0', url: 'https://v1.100.0.archive.immich.app', rootPath: '/docs' },
      ]);
    });

    it('serves v1.143.1 and newer from the docs subdomain', async () => {
      await clearReleases();
      await insertRelease({ id: 1, tag_name: 'v1.143.0' });
      await insertRelease({ id: 2, tag_name: 'v1.143.1' });
      await insertRelease({ id: 3, tag_name: 'v3.1.0' });

      expect(await fetchDocsVersions()).toEqual([
        { label: 'v3.1.0', url: 'https://docs.v3.1.0.archive.immich.app' },
        { label: 'v1.143.1', url: 'https://docs.v1.143.1.archive.immich.app' },
      ]);
    });

    it('keeps only the newest patch of each minor', async () => {
      await clearReleases();
      await insertRelease({ id: 1, tag_name: 'v2.0.0' });
      await insertRelease({ id: 2, tag_name: 'v2.0.3' });
      await insertRelease({ id: 3, tag_name: 'v2.0.1' });
      await insertRelease({ id: 4, tag_name: 'v2.1.0' });

      const versions = await fetchDocsVersions();
      expect(versions.map(({ label }) => label)).toEqual(['v2.1.0', 'v2.0.3']);
    });

    it('excludes pre-releases', async () => {
      await insertRelease({ id: 99, tag_name: 'v1.121.0-rc.1' });

      const versions = await fetchDocsVersions();
      expect(versions.map(({ label }) => label)).not.toContain('v1.121.0-rc.1');
    });

    it('excludes releases older than v1.100.0, which were never archived', async () => {
      await insertRelease({ id: 98, tag_name: 'v1.99.0' });

      const versions = await fetchDocsVersions();
      expect(versions.map(({ label }) => label)).not.toContain('v1.99.0');
    });

    it('returns an empty list when D1 has no data', async () => {
      await clearReleases();

      expect(await fetchDocsVersions()).toEqual([]);
    });

    it('includes Cache-Control header for CDN caching', async () => {
      const response = await exports.default.fetch('https://example.com/v1/docs/versions');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const response = await exports.default.fetch('https://example.com/unknown');
      expect(response.status).toBe(404);
    });

    it('returns 404 for the removed /changelog route', async () => {
      const response = await exports.default.fetch('https://example.com/changelog?version=v1.100.0');
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    });
  });

  describe('http_response metric', () => {
    it('tags a known route and method as they are', async () => {
      const line = await httpResponseLine('https://example.com/health');
      expect(line).toContain(',method=GET,');
      expect(line).toContain(',path=/health,');
      expect(line).toContain(',status=200');
    });

    it('keeps tagging the removed /changelog route by its path', async () => {
      const line = await httpResponseLine('https://example.com/changelog?version=v1.100.0');
      expect(line).toContain(',path=/changelog,');
      expect(line).toContain(',status=404');
    });

    it('buckets an unknown path as other', async () => {
      const line = await httpResponseLine('https://example.com/wp-login.php');
      expect(line).toContain(',path=other,');
      expect(line).toContain(',status=404');
      expect(line).not.toContain('wp-login');
    });

    it('buckets an unknown method as other', async () => {
      const line = await httpResponseLine('https://example.com/', { method: 'PROPFIND' });
      expect(line).toContain(',method=other,');
      expect(line).toContain(',path=/,');
      expect(line).not.toContain('PROPFIND');
    });
  });
});

describe('Cron sync', () => {
  const GITHUB_RELEASES = 'https://api.github.com/repos/immich-app/immich/releases';
  let githubReleases: Record<string, unknown>[];
  let requested: string[];

  beforeEach(async () => {
    versionCaches.clear();
    await clearReleases();
    githubReleases = mockReleases.map((release) => ({ ...release, prerelease: false }));
    requested = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const { href } = new URL(new Request(input, init).url);
      requested.push(href);
      const body = {
        [`${GITHUB_RELEASES}/latest`]: githubReleases.find((release) => !release.prerelease),
        [`${GITHUB_RELEASES}?per_page=100&page=1`]: githubReleases,
      }[href];
      return body === undefined
        ? Promise.reject(new Error(`unexpected fetch: ${href}`))
        : Promise.resolve(Response.json(body));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.VERSION_DB.exec('DELETE FROM releases');
  });

  it('fills an empty table with a full fetch on the next run, whatever the legacy table holds', async () => {
    await env.VERSION_DB.prepare(
      "INSERT INTO releases (id, tag_name, major, minor, patch) VALUES (3, 'v1.120.0', 1, 120, 0)",
    ).run();
    const before = await exports.default.fetch('https://example.com/version');
    expect(before.status).toBe(404);

    await runCron('*/30 * * * *');

    expect(requested).toEqual([`${GITHUB_RELEASES}/latest`, `${GITHUB_RELEASES}?per_page=100&page=1`]);
    expect(await storedReleases()).toEqual([
      expect.objectContaining({ tag: 'v1.100.0', published_at: '2025-01-01T00:00:00Z', source_id: '1' }),
      expect.objectContaining({ tag: 'v1.110.0', published_at: '2025-02-01T00:00:00Z', source_id: '2' }),
      expect.objectContaining({ tag: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', source_id: '3' }),
    ]);
    expect(await fullSyncedAt()).not.toBeNull();
    expect(await fetchVersion()).toEqual({ version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' });
  });

  it('only asks GitHub for its latest release once that is stored, and writes nothing', async () => {
    await runCron('*/30 * * * *');
    const before = await storedReleases();
    requested = [];

    await runCron('*/30 * * * *');

    expect(requested).toEqual([`${GITHUB_RELEASES}/latest`]);
    expect(await storedReleases()).toEqual(before);
  });

  it('writes only new and changed releases on the nightly full sync', async () => {
    await runCron('*/30 * * * *');
    await env.VERSION_DB.exec("UPDATE project_releases SET synced_at = 'before'");
    githubReleases = [
      { id: 4, tag_name: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z', prerelease: true },
      { id: 3, tag_name: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', prerelease: false },
      { id: 2, tag_name: 'v1.110.0', published_at: '2025-02-02T00:00:00Z', prerelease: false },
      { id: 1, tag_name: 'v1.100.0', published_at: '2025-01-01T00:00:00Z', prerelease: true },
      { id: 0, tag_name: 'v1.13.0_20-dev', published_at: '2023-01-01T00:00:00Z', prerelease: false },
    ];

    await runCron('0 3 * * *');

    const stored = await storedReleases();
    expect(
      stored.map(({ tag, published_at, forge_prerelease, synced_at }) => ({
        tag,
        published_at,
        forge_prerelease,
        rewritten: synced_at !== 'before',
      })),
    ).toEqual([
      // Only GitHub's prerelease flag changed.
      { tag: 'v1.100.0', published_at: '2025-01-01T00:00:00Z', forge_prerelease: 1, rewritten: true },
      { tag: 'v1.110.0', published_at: '2025-02-02T00:00:00Z', forge_prerelease: 0, rewritten: true },
      { tag: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', forge_prerelease: 0, rewritten: false },
      { tag: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z', forge_prerelease: 1, rewritten: true },
    ]);
    expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.1' });
  });
});

describe('GitHubRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps pre-releases but drops drafts when syncing from GitHub', async () => {
    const githubReleases = [
      { id: 1, tag_name: 'v1.120.0', name: 'v1.120.0', url: '', body: '', created_at: '', published_at: '' },
      {
        id: 2,
        tag_name: 'v1.121.0-rc.1',
        name: 'v1.121.0-rc.1',
        url: '',
        body: '',
        created_at: '',
        published_at: '',
        prerelease: true,
      },
      {
        id: 3,
        tag_name: 'v1.122.0',
        name: 'v1.122.0',
        url: '',
        body: '',
        created_at: '',
        published_at: '',
        draft: true,
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(new Request(input, init).url);
      return url.origin === 'https://api.github.com' && url.pathname === '/repos/immich-app/immich/releases'
        ? Promise.resolve(Response.json(githubReleases))
        : Promise.reject(new Error(`unexpected fetch: ${url.href}`));
    });

    const releases = await new GitHubRepository().fetchReleases();
    const tags = releases.map((r) => r.tag_name);

    expect(tags).toContain('v1.121.0-rc.1'); // pre-release retained for the rc channel
    expect(tags).toContain('v1.120.0');
    expect(tags).not.toContain('v1.122.0'); // draft still dropped
  });

  it("keeps GitHub's prerelease flag and maps a release to a stored row", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json([
        { id: 2, tag_name: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z', prerelease: true },
        { id: 1, tag_name: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' },
      ]),
    );

    const releases = await new GitHubRepository().fetchReleases();

    expect(releases.map((release) => toProjectRelease(release))).toEqual([
      { tag: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z', source_id: '2', forge_prerelease: true },
      { tag: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', source_id: '1', forge_prerelease: false },
    ]);
  });
});

describe('CDN cache immutable headers fix', () => {
  it('cached responses must be wrapped to allow header mutation', async () => {
    const cache = caches.default;
    const key = new Request('https://example.com/test-immutable-headers');

    const original = Response.json(
      { data: 'test' },
      {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      },
    );
    await cache.put(key, original.clone());

    const cached = await cache.match(key);
    expect(cached).not.toBeNull();

    // Cached responses have immutable headers - setting directly would throw
    expect(() => cached!.headers.set('Server-Timing', 'test;dur=1')).toThrow();

    // The fix: wrapping in new Response() creates mutable headers
    const mutable = new Response(cached!.body, cached!);
    expect(() => mutable.headers.set('Server-Timing', 'test;dur=1')).not.toThrow();
    expect(mutable.headers.get('Server-Timing')).toBe('test;dur=1');

    // Verify body is preserved
    const body = (await mutable.json()) as any;
    expect(body.data).toBe('test');

    await cache.delete(key);
  });
});

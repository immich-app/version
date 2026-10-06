import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { createWorker } from './index.js';
import { MemoryCache } from './memory-cache.js';
import { legacyProject, loadProjects, projects } from './projects.js';
import {
  clearReleases,
  createWebhookSignature,
  EDGE,
  fetchFrom,
  fullSyncedAt,
  IMMICH_REPOSITORY,
  insertRelease,
  loggedLines,
  publishRelease,
  runCron,
  seriesTags,
  storedReleases,
  storedTags,
} from './test/helpers.js';
import type { DocsVersion, VersionResponse } from './types.js';
import { versionCaches } from './version-service.js';
import { verifyWebhookSignature } from './webhook.js';

const mockReleases = [
  { id: 3, tag_name: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' },
  { id: 2, tag_name: 'v1.110.0', published_at: '2025-02-01T00:00:00Z' },
  { id: 1, tag_name: 'v1.100.0', published_at: '2025-01-01T00:00:00Z' },
];

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

async function httpResponseLine(url: string, init?: RequestInit) {
  const lines = await loggedLines(() => exports.default.fetch(url, init));
  const line = lines.find((l) => l.startsWith('version_http_response,'));
  expect(line).toBeDefined();
  return line!;
}

// A second project, on its own repository, served on a beta channel by default.
const [notes] = loadProjects({
  projects: [
    {
      id: 'notes',
      name: 'Notes',
      source: { type: 'github-releases', repo: 'futo-org/notes', repoId: 7 },
      tags: { pattern: String.raw`^v(?<version>\d+\.\d+\.\d+(?:-beta\.\d+)?)$`, scheme: 'semver' },
      channels: { stable: [], beta: ['beta'] },
      defaultChannel: 'beta',
      analytics: { clientIdentity: false },
      examples: { 'v1.0.0': { version: '1.0.0', channels: ['stable', 'beta'] } },
    },
  ],
});
const withNotes = createWorker({ projects: [...projects, notes] });

// A response from the worker with the notes project registered, without Server-Timing.
async function get(path: string, init?: RequestInit) {
  const response = await fetchFrom(withNotes, `https://example.com${path}`, init);
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([name]) => name !== 'server-timing')),
    body: await response.text(),
  };
}

async function getJson(path: string): Promise<unknown> {
  const { body } = await get(path);
  return JSON.parse(body);
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

    it('advertises HEAD, and no POST, for the project route', async () => {
      const response = await exports.default.fetch('https://example.com/v1/projects/immich/version', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'HEAD', 'Access-Control-Request-Headers': 'Content-Type' },
      });
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
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

    // Posts a signed delivery with any body.
    async function deliver(body: string, event = 'release') {
      return await exports.default.fetch('https://example.com/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-Hub-Signature-256': await createWebhookSignature(body, webhookSecret),
          'X-GitHub-Event': event,
        },
      });
    }

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
      const response = await deliver(JSON.stringify({ action: 'opened' }), 'pull_request');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ignored: true });
    });

    it('ignores non-published release actions', async () => {
      const response = await deliver(JSON.stringify({ action: 'created', release: {}, repository: IMMICH_REPOSITORY }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ignored: true });
    });

    it.each(['{"action":', 'null', '[]', '"published"'])('returns 400 for the signed body %s', async (body) => {
      const response = await deliver(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid JSON payload' });
    });

    it('upserts a published release and invalidates cache', async () => {
      // Prime the cache
      await exports.default.fetch('https://example.com/version');

      const response = await publishRelease({
        id: 4,
        tag_name: 'v1.130.0',
        name: 'v1.130.0',
        body: 'New release',
        published_at: '2025-04-01T00:00:00Z',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });

      // Verify the new release is now the latest (cache was invalidated)
      expect(await fetchVersion()).toMatchObject({ version: 'v1.130.0' });
    });

    it('updates an existing release in place', async () => {
      await publishRelease({ id: 3, tag_name: 'v1.120.0', published_at: '2025-03-02T00:00:00Z' });

      expect(await fetchVersion()).toEqual({ version: 'v1.120.0', published_at: '2025-03-02T00:00:00Z' });
      expect(await storedReleases()).toHaveLength(mockReleases.length);
    });

    it('returns 400 for invalid release payload', async () => {
      const response = await publishRelease({ no_id: true });
      expect(response.status).toBe(400);
    });

    it('ignores draft releases', async () => {
      const response = await publishRelease({ id: 5, tag_name: 'v1.140.0', published_at: '', draft: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ignored: true });
      expect(await storedReleases()).toHaveLength(mockReleases.length);
    });

    it('stores prerelease releases for the rc channel', async () => {
      const response = await publishRelease({
        id: 6,
        tag_name: 'v1.121.0-rc.1',
        published_at: '2025-03-15T00:00:00Z',
        prerelease: true,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });

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
        const lines = await loggedLines(async () => {
          const response = await publishRelease(
            { id: 7, tag_name: tag, published_at: '2025-04-01T00:00:00Z' },
            { init: EDGE },
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ success: true });
        });

        const stored = await storedReleases();
        expect(stored.map((release) => release.tag)).not.toContain(tag);
        expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.120.0' });
        expect(seriesTags(lines).version_webhook_ignored).toEqual([{ reason: 'unmatched_tag', colo: 'LHR' }]);
      },
    );

    it('never marks the project as fully synced', async () => {
      await publishRelease({ id: 8, tag_name: 'v1.130.0', published_at: '2025-04-01T00:00:00Z' });

      expect(await storedReleases()).toContainEqual(expect.objectContaining({ tag: 'v1.130.0' }));
      expect(await fullSyncedAt()).toBeNull();
    });

    it.each([
      ['no repository', null],
      ['an unregistered repository', { id: 1, full_name: 'immich-app/other' }],
      ["another repository under Immich's name", { id: 1, full_name: 'immich-app/immich' }],
    ])('ignores a signed delivery from %s, and stores nothing', async (_, repository) => {
      const lines = await loggedLines(async () => {
        const response = await publishRelease(
          { id: 9, tag_name: 'v9.0.0', published_at: '2025-04-01T00:00:00Z' },
          { repository, init: EDGE },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ignored: true });
      });

      expect(await storedTags()).not.toContain('v9.0.0');
      expect(seriesTags(lines).version_webhook_ignored).toEqual([{ reason: 'unknown_repo', colo: 'LHR' }]);
    });

    it.each([
      ['its id, after a rename', { id: IMMICH_REPOSITORY.id, full_name: 'immich-app/renamed' }],
      ['its name, in any case, when the payload has no id', { full_name: 'Immich-App/Immich' }],
    ])('finds the project by %s', async (_, repository) => {
      await publishRelease({ id: 10, tag_name: 'v1.130.0', published_at: '2025-04-01T00:00:00Z' }, { repository });

      expect(await fetchVersion()).toMatchObject({ version: 'v1.130.0' });
    });

    it("stores a release under the project whose repository sent it, never Immich's", async () => {
      const response = await publishRelease(
        { id: 11, tag_name: 'v9.0.0-beta.1', published_at: '2025-04-01T00:00:00Z', prerelease: true },
        { repository: { id: 7, full_name: 'futo-org/notes' }, handler: withNotes },
      );

      expect(await response.json()).toEqual({ success: true });
      expect(await storedReleases('notes')).toEqual([expect.objectContaining({ tag: 'v9.0.0-beta.1' })]);
      expect(await storedTags()).not.toContain('v9.0.0-beta.1');
    });

    it("goes by the repository's id when its name is another project's", async () => {
      await publishRelease(
        { id: 13, tag_name: 'v9.0.0', published_at: '2025-04-01T00:00:00Z' },
        { repository: { id: 7, full_name: 'immich-app/immich' }, handler: withNotes },
      );

      expect(await storedReleases('notes')).toEqual([expect.objectContaining({ tag: 'v9.0.0' })]);
      expect(await storedTags()).not.toContain('v9.0.0');
    });

    it('stores a release under every project on the repository whose pattern takes it', async () => {
      const [desktop, mobile] = loadProjects({
        projects: ['desktop', 'mobile'].map((id) => ({
          id,
          name: id,
          source: { type: 'github-releases', repo: 'futo-org/app', repoId: 8 },
          tags: { pattern: String.raw`^${id}-v(?<version>\d+\.\d+\.\d+)$`, scheme: 'semver' },
          channels: { stable: [] },
          defaultChannel: 'stable',
          analytics: { clientIdentity: false },
          examples: { [`${id}-v1.0.0`]: { version: '1.0.0', channels: ['stable'] } },
        })),
      });
      const handler = createWorker({ projects: [...projects, desktop, mobile] });
      const repository = { id: 8, full_name: 'futo-org/app' };

      await publishRelease({ id: 12, tag_name: 'mobile-v2.0.0', published_at: '' }, { repository, handler });

      expect(await storedReleases('mobile')).toEqual([expect.objectContaining({ tag: 'mobile-v2.0.0' })]);
      expect(await storedReleases('desktop')).toEqual([]);
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

  describe('GET /v1/projects/{id}/version', () => {
    const JSON_HEADERS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    const CACHED_JSON_HEADERS = { ...JSON_HEADERS, 'cache-control': 'public, max-age=300' };

    beforeEach(async () => {
      await insertRelease({ id: 20, tag_name: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z' });
      await insertRelease({ id: 1, tag_name: 'v1.0.0', published_at: '2025-01-01T00:00:00Z' }, 'notes');
      await insertRelease({ id: 2, tag_name: 'v1.1.0-beta.1', published_at: '2025-02-01T00:00:00Z' }, 'notes');
    });

    it.each([
      ['', 'stable', '1.120.0', 'v1.120.0', '2025-03-01T00:00:00Z'],
      ['?channel=stable', 'stable', '1.120.0', 'v1.120.0', '2025-03-01T00:00:00Z'],
      ['?channel=rc', 'rc', '1.121.0-rc.1', 'v1.121.0-rc.1', '2025-03-15T00:00:00Z'],
    ])("serves Immich's newest release for %j", async (query, channel, version, tag, published) => {
      expect(await get(`/v1/projects/immich/version${query}`)).toEqual({
        status: 200,
        headers: CACHED_JSON_HEADERS,
        body: `{"project":"immich","channel":"${channel}","version":"${version}","tag":"${tag}","published_at":"${published}"}`,
      });
    });

    it("defaults to the project's own default channel", async () => {
      expect(await getJson('/v1/projects/notes/version')).toEqual({
        project: 'notes',
        channel: 'beta',
        version: '1.1.0-beta.1',
        tag: 'v1.1.0-beta.1',
        published_at: '2025-02-01T00:00:00Z',
      });
      expect(await getJson('/v1/projects/notes/version?channel=stable')).toMatchObject({
        channel: 'stable',
        tag: 'v1.0.0',
      });
    });

    it("serves the registry's projects through the worker's own entrypoint", async () => {
      const response = await exports.default.fetch('https://example.com/v1/projects/immich/version');
      expect(await response.json()).toMatchObject({ project: 'immich', tag: 'v1.120.0' });
      const unregistered = await exports.default.fetch('https://example.com/v1/projects/notes/version');
      expect(unregistered.status).toBe(404);
    });

    it("lists the project's channels for one it doesn't have, and lets nothing cache the error", async () => {
      expect(await get('/v1/projects/notes/version?channel=rc')).toEqual({
        status: 400,
        headers: JSON_HEADERS,
        body: '{"error":"Invalid release channel","channels":["stable","beta"]}',
      });
      expect(await get('/v1/projects/immich/version?channel=__proto__')).toMatchObject({
        status: 400,
        body: '{"error":"Invalid release channel","channels":["stable","rc"]}',
      });
    });

    it.each(['unknown', 'Immich', '__proto__', 'constructor'])('answers the unregistered %j with 404', async (id) => {
      expect(await get(`/v1/projects/${id}/version`)).toEqual({
        status: 404,
        headers: JSON_HEADERS,
        body: '{"error":"Unknown project"}',
      });
    });

    it('answers 404 when the channel has no release', async () => {
      await clearReleases();
      expect(await get('/v1/projects/immich/version')).toEqual({
        status: 404,
        headers: JSON_HEADERS,
        body: '{"error":"No releases found"}',
      });
    });

    it.each(['POST', 'PUT', 'DELETE'])('answers %s with 405 and the methods it allows', async (method) => {
      expect(await get('/v1/projects/immich/version', { method })).toEqual({
        status: 405,
        headers: { ...JSON_HEADERS, allow: 'GET, HEAD' },
        body: '{"error":"Method Not Allowed"}',
      });
    });

    it('answers HEAD with the headers of a GET and no body', async () => {
      expect(await get('/v1/projects/immich/version', { method: 'HEAD' })).toEqual({
        status: 200,
        headers: CACHED_JSON_HEADERS,
        body: '',
      });
      expect(await get('/v1/projects/unknown/version', { method: 'HEAD' })).toMatchObject({ status: 404, body: '' });
    });

    it('answers HEAD without a body when the route fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const broken = {
        prepare: () => {
          throw new Error('D1 is down');
        },
      } as unknown as D1Database;
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
      const fail = (method: string) =>
        worker.fetch(
          new Request('https://example.com/v1/projects/immich/version', { method }),
          { ...env, VERSION_DB: broken },
          ctx,
        );

      const head = await fail('HEAD');
      expect(head.status).toBe(500);
      expect(await head.text()).toBe('');
      const get = await fail('GET');
      expect(get.status).toBe(500);
      expect(await get.json()).toEqual({ error: 'Internal Server Error' });
    });

    it.each([
      '/v1/projects/immich/version/',
      '/v1/projects/immich',
      '/v1/projects//version',
      '/v1/projects/a/b/version',
    ])('leaves %s to the 404 for unknown routes', async (path) => {
      expect(await get(path)).toMatchObject({ status: 404, body: '{"error":"Not Found"}' });
    });

    it('shares the memory cache with /version', async () => {
      await get('/version');
      await clearReleases();

      expect(await get('/v1/projects/immich/version')).toMatchObject({ status: 200 });
    });

    it("tags a project's request with its id and the colo, and its client only if the project allows", async () => {
      const client = { 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'notes/1.0.0' };
      const immichSeries = seriesTags(
        await loggedLines(() =>
          exports.default.fetch('https://example.com/v1/projects/immich/version', { ...EDGE, headers: client }),
        ),
      );
      const notesSeries = seriesTags(
        await loggedLines(() => get('/v1/projects/notes/version', { ...EDGE, headers: client })),
      );

      expect(immichSeries.version_version_request).toEqual([
        {
          version_project: 'immich',
          colo: 'LHR',
          client_ip: '192.0.2.1',
          user_agent: 'notes/1.0.0',
          continent: 'EU',
          asOrg: 'Example AS',
        },
      ]);
      expect(immichSeries.version_http_response).toEqual([
        { method: 'GET', path: '/v1/projects/:project/version', status: '200', colo: 'LHR' },
      ]);
      expect(notesSeries.version_version_request).toEqual([{ version_project: 'notes', colo: 'LHR' }]);
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

    it('tags the per-project route by its template, whatever the id', async () => {
      const line = await httpResponseLine('https://example.com/v1/projects/no-such-project/version');
      expect(line).toContain(',path=/v1/projects/:project/version,');
      expect(line).toContain(',status=404');
      expect(line).not.toContain('no-such-project');
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

  describe('metric tags', () => {
    const IMMICH_SERVER = { 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'immich-server/v1.120.0' };

    it("tags /version's series with the project and the colo, and only its own with the client", async () => {
      const series = seriesTags(
        await loggedLines(() =>
          exports.default.fetch('https://example.com/version', { ...EDGE, headers: IMMICH_SERVER }),
        ),
      );

      const project = { version_project: 'immich', colo: 'LHR' };
      expect(series).toEqual({
        version_memory_cache_miss: [project],
        version_d1_get_latest: [project],
        version_version_request: [
          {
            ...project,
            client_ip: '192.0.2.1',
            user_agent: 'immich-server/v1.120.0',
            continent: 'EU',
            asOrg: 'Example AS',
          },
        ],
        version_handle_request: [{ continent: 'EU', colo: 'LHR', asOrg: 'Example AS' }],
        version_http_response: [{ method: 'GET', path: '/version', status: '200', colo: 'LHR' }],
      });
    });

    it("tags /v1/docs/versions' series with the project and the colo", async () => {
      const series = seriesTags(
        await loggedLines(() => exports.default.fetch('https://example.com/v1/docs/versions', EDGE)),
      );

      expect(series.version_d1_get_docs_versions).toEqual([{ version_project: 'immich', colo: 'LHR' }]);
      expect(series.version_docs_versions_request).toEqual([{ version_project: 'immich', colo: 'LHR' }]);
    });

    // wrangler.toml leaves ENVIRONMENT empty, which turns the CDN cache off, so
    // this calls the handler directly with it set.
    it('tags a CDN hit on /v1/docs/versions with the project, the colo and cache=cdn', async () => {
      const url = 'https://example.com/v1/docs/versions';
      await caches.default.put(url, new Response('[]', { headers: { 'Cache-Control': 'public, max-age=60' } }));
      const waiting: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => {
          waiting.push(promise);
        },
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext;

      try {
        const series = seriesTags(
          await loggedLines(async () => {
            const response = await worker.fetch(new Request(url, EDGE), { ...env, ENVIRONMENT: 'dev' }, ctx);
            expect(await response.json()).toEqual([]);
            await Promise.all(waiting);
          }),
        );

        expect(series.version_docs_versions_request).toEqual([
          { version_project: 'immich', colo: 'LHR', cache: 'cdn' },
        ]);
        expect(series.version_d1_get_docs_versions).toBeUndefined();
      } finally {
        await caches.default.delete(url);
      }
    });
  });
});

describe('Cron sync', () => {
  // Immich alone, so registering another project changes nothing these runs fetch.
  const immichOnly = createWorker({ projects: [legacyProject] });
  const runImmichCron = (cron: string) => runCron(cron, { handler: immichOnly });
  // immich-app/immich, by its id.
  const GITHUB_RELEASES = 'https://api.github.com/repositories/455229168/releases';
  const FULL = `${GITHUB_RELEASES}?per_page=100&page=1`;
  const RECENT = `${GITHUB_RELEASES}?per_page=20`;
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
      const body = { [FULL]: githubReleases, [RECENT]: githubReleases.slice(0, 20) }[href];
      // One release, by its id: the listed one, or a 404.
      const releaseId = href.startsWith(`${GITHUB_RELEASES}/`) ? href.slice(GITHUB_RELEASES.length + 1) : undefined;
      if (releaseId !== undefined) {
        const listed = githubReleases.find(({ id }) => String(id) === releaseId);
        return Promise.resolve(listed ? Response.json(listed) : new Response(null, { status: 404 }));
      }
      return body === undefined
        ? Promise.reject(new Error(`unexpected fetch: ${href}`))
        : Promise.resolve(Response.json(body));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills an empty table with a full fetch on the next run', async () => {
    const before = await exports.default.fetch('https://example.com/version');
    expect(before.status).toBe(404);

    await runImmichCron('*/30 * * * *');

    expect(requested).toEqual([FULL]);
    expect(await storedReleases()).toEqual([
      expect.objectContaining({ tag: 'v1.100.0', published_at: '2025-01-01T00:00:00Z', source_id: '1' }),
      expect.objectContaining({ tag: 'v1.110.0', published_at: '2025-02-01T00:00:00Z', source_id: '2' }),
      expect.objectContaining({ tag: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', source_id: '3' }),
    ]);
    expect(await fullSyncedAt()).not.toBeNull();
    expect(await fetchVersion()).toEqual({ version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' });
  });

  it('only lists the newest releases once a full sync has run, and writes what is new', async () => {
    await runImmichCron('*/30 * * * *');
    await env.VERSION_DB.exec("UPDATE project_releases SET synced_at = 'before'");
    githubReleases.unshift({
      id: 4,
      tag_name: 'v1.121.0-rc.1',
      published_at: '2025-03-15T00:00:00Z',
      prerelease: true,
    });
    requested = [];

    await runImmichCron('*/30 * * * *');

    expect(requested).toEqual([RECENT]);
    const rewritten = await storedReleases();
    expect(rewritten.filter(({ synced_at }) => synced_at !== 'before')).toEqual([
      expect.objectContaining({ tag: 'v1.121.0-rc.1', source_id: '4', forge_prerelease: 1 }),
    ]);
    expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.1' });
  });

  it('reports what is stored after a sync, with a retagged release only under its new tag', async () => {
    await runImmichCron('*/30 * * * *');
    // v1.120.0 was tagged by mistake, and GitHub's release now says v1.115.0.
    githubReleases[0] = { ...githubReleases[0], tag_name: 'v1.115.0' };

    const series = seriesTags(await loggedLines(() => runImmichCron('*/30 * * * *')));

    expect(await storedTags()).toEqual(['v1.100.0', 'v1.110.0', 'v1.115.0']);
    expect(series.version_latest_version).toEqual([
      { version_project: 'immich', version: '1.115.0', user_agent: 'immich-server/1.115.0' },
    ]);
  });

  it('keeps fetching everything until a full sync succeeds, even after a webhook stored the latest release', async () => {
    await publishRelease(githubReleases[0]);

    await runImmichCron('*/30 * * * *');

    expect(requested).toEqual([FULL]);
    expect(await storedReleases()).toHaveLength(3);
    expect(await fullSyncedAt()).not.toBeNull();
  });

  it("tags the sync's series with the project, and the run's heartbeat with none", async () => {
    const series = seriesTags(await loggedLines(() => runImmichCron('*/30 * * * *')));

    const immich = { version_project: 'immich' };
    expect(series).toEqual({
      // The heartbeat, then the run's duration.
      version_cron_sync: [{}, {}],
      version_project_sync: [immich],
      version_source_fetch_all: [{ ...immich, source: 'github-releases' }],
      version_d1_bulk_upsert: [immich],
      version_releases_written: [{ ...immich, mode: 'full' }],
      version_releases_deleted: [immich],
      version_tags_skipped: [immich],
      version_project_sync_outcome: [immich],
      version_d1_release_count: [immich],
      version_latest_version: [{ ...immich, version: '1.120.0', user_agent: 'immich-server/1.120.0' }],
    });
  });

  it("writes the webhook's release stats to the crons' series, without the request's geo", async () => {
    githubReleases = [{ id: 4, tag_name: 'v1.130.0', published_at: '2025-04-01T00:00:00Z', prerelease: false }];

    const webhook = seriesTags(await loggedLines(() => publishRelease(githubReleases[0], { init: EDGE })));
    const cron = seriesTags(await loggedLines(() => runImmichCron('*/30 * * * *')));

    expect(webhook.version_webhook_received).toEqual([{ event: 'release', colo: 'LHR' }]);
    expect(webhook.version_webhook_upsert).toEqual([{ version_project: 'immich', colo: 'LHR' }]);
    expect(webhook.version_webhook_release_upserted).toEqual([
      { version_project: 'immich', tag: 'v1.130.0', colo: 'LHR' },
    ]);
    for (const series of [webhook, cron]) {
      expect(series.version_d1_release_count).toEqual([{ version_project: 'immich' }]);
      expect(series.version_latest_version).toEqual([
        { version_project: 'immich', version: '1.130.0', user_agent: 'immich-server/1.130.0' },
      ]);
    }
  });

  it('writes only new and changed releases on the nightly full sync, and deletes retracted ones', async () => {
    await runImmichCron('*/30 * * * *');
    // A time long past, like any earlier run's: a delete only takes rows written before its checks.
    await env.VERSION_DB.exec("UPDATE project_releases SET synced_at = '2000-01-01T00:00:00.000Z'");
    githubReleases = [
      { id: 4, tag_name: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z', prerelease: true },
      { id: 3, tag_name: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', prerelease: false },
      { id: 1, tag_name: 'v1.100.0', published_at: '2025-01-01T00:00:00Z', prerelease: true },
      { id: 0, tag_name: 'v1.13.0_20-dev', published_at: '2023-01-01T00:00:00Z', prerelease: false },
    ];
    requested = [];

    await runImmichCron('0 3 * * *');

    // GitHub confirms that v1.110.0 is gone.
    expect(requested).toEqual([FULL, `${GITHUB_RELEASES}/2`]);
    const stored = await storedReleases();
    expect(
      stored.map(({ tag, published_at, forge_prerelease, synced_at }) => ({
        tag,
        published_at,
        forge_prerelease,
        rewritten: synced_at !== '2000-01-01T00:00:00.000Z',
      })),
    ).toEqual([
      // Only GitHub's prerelease flag changed. v1.110.0 is no longer listed.
      { tag: 'v1.100.0', published_at: '2025-01-01T00:00:00Z', forge_prerelease: 1, rewritten: true },
      { tag: 'v1.120.0', published_at: '2025-03-01T00:00:00Z', forge_prerelease: 0, rewritten: false },
      { tag: 'v1.121.0-rc.1', published_at: '2025-03-15T00:00:00Z', forge_prerelease: 1, rewritten: true },
    ]);
    expect(await fetchVersion('rc')).toMatchObject({ version: 'v1.121.0-rc.1' });
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

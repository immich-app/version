import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { versionCaches } from './version-service.js';

// Golden tests for the routes Immich already depends on. Immich servers poll
// /version, and the docs site and archived docs read /v1/docs/versions, so their
// status, exact body bytes and headers must never change. Compare whole strings
// here, never parsed JSON: key order and escaping are part of the contract. And
// compare whole responses with toEqual, never toMatchObject, which would pass a
// response that gained a header.

const RELEASES: [tag: string, publishedAt: string][] = [
  ['v1.99.0', '2023-01-01T00:00:00Z'],
  ['v1.100.0', '2024-03-19T00:00:00Z'],
  ['v1.106.3', '2024-06-01T00:00:00Z'],
  ['v1.106.4', '2024-06-08T00:00:00Z'],
  ['v1.143.0', '2025-09-01T00:00:00Z'],
  ['v1.143.1', '2025-09-05T00:00:00Z'],
  ['v2.0.0-rc.1', '2025-09-20T00:00:00Z'],
  ['v2.0.0', '2025-10-01T00:00:00Z'],
  ['v3.0.0-rc.1', '2026-01-01T00:00:00Z'],
  ['v3.0.0-rc.2', '2026-01-08T00:00:00Z'],
  // A patch to the older line, published after the newest rc.
  ['v2.0.1', '2026-01-10T00:00:00Z'],
];

async function seed() {
  for (const [index, [tag, publishedAt]] of RELEASES.entries()) {
    await env.VERSION_DB.prepare(
      `INSERT INTO project_releases (project, tag, published_at, source_id, forge_prerelease, synced_at)
       VALUES ('immich', ?1, ?2, ?3, ?4, '2026-01-10T00:00:00Z')`,
    )
      .bind(tag, publishedAt, String(index + 1), Number(tag.includes('-')))
      .run();
  }
}

async function clear() {
  await env.VERSION_DB.exec('DELETE FROM project_releases');
}

function resetCaches() {
  versionCaches.clear();
}

// Server-Timing carries the durations of the operations that ran, so only its
// entry names are stable.
const timingNames = (response: Response) => response.headers.get('Server-Timing')?.replaceAll(/;dur=[\d.]+/g, '');

async function get(path: string, init?: RequestInit) {
  const response = await exports.default.fetch(`https://example.com${path}`, init);
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([name]) => name !== 'server-timing')),
    timing: timingNames(response),
    body: await response.text(),
  };
}

// Which operations ran depends on the cache state, so only the cache cases pin
// Server-Timing's names. The rest only require the header.
const ANY_TIMING = expect.any(String);
const JSON_HEADERS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const ok = (body: string) => ({ status: 200, headers: JSON_HEADERS, timing: ANY_TIMING, body });
const NO_RELEASES = { status: 404, headers: JSON_HEADERS, timing: ANY_TIMING, body: '{"error":"No releases found"}' };
const INVALID_CHANNEL = {
  status: 400,
  headers: JSON_HEADERS,
  timing: ANY_TIMING,
  body: String.raw`{"error":"Invalid release channel. Expected \"stable\" or \"rc\""}`,
};

beforeEach(async () => {
  resetCaches();
  await clear();
  await seed();
});

describe('GET /version (golden)', () => {
  const STABLE = '{"version":"v2.0.1","published_at":"2026-01-10T00:00:00Z"}';
  const RC = '{"version":"v3.0.0-rc.2","published_at":"2026-01-08T00:00:00Z"}';

  it('serves the newest stable release by default', async () => {
    expect(await get('/version')).toEqual({
      status: 200,
      headers: JSON_HEADERS,
      timing: 'version_d1_get_latest, version_version_request, version_handle_request',
      body: STABLE,
    });
  });

  it('serves the same release from the memory cache', async () => {
    await get('/version');
    expect(await get('/version')).toEqual({
      status: 200,
      headers: JSON_HEADERS,
      timing: 'version_version_request, version_handle_request',
      body: STABLE,
    });
  });

  it.each([
    ['stable', STABLE],
    ['rc', RC],
  ])('serves ?channel=%s', async (channel, body) => {
    expect(await get(`/version?channel=${channel}`)).toEqual(ok(body));
  });

  it('accepts any method', async () => {
    expect(await get('/version', { method: 'POST' })).toEqual(ok(STABLE));
    expect(await get('/version?channel=rc', { method: 'DELETE' })).toEqual(ok(RC));
  });

  it.each(['nightly', '', 'RC', 'Stable', '__proto__'])('rejects ?channel=%j with the exact 400', async (channel) => {
    expect(await get(`/version?channel=${channel}`)).toEqual(INVALID_CHANNEL);
  });

  it.each(['/version', '/version?channel=stable', '/version?channel=rc'])(
    'answers %s with the exact 404 when nothing is stored',
    async (path) => {
      await clear();
      expect(await get(path)).toEqual(NO_RELEASES);
    },
  );
});

describe('GET /v1/docs/versions (golden)', () => {
  const DOCS_HEADERS = { ...JSON_HEADERS, 'cache-control': 'public, max-age=3600' };
  const ARCHIVED =
    '[{"label":"v2.0.1","url":"https://docs.v2.0.1.archive.immich.app"},' +
    '{"label":"v1.143.1","url":"https://docs.v1.143.1.archive.immich.app"},' +
    '{"label":"v1.106.4","url":"https://v1.106.4.archive.immich.app","rootPath":"/docs"},' +
    '{"label":"v1.100.0","url":"https://v1.100.0.archive.immich.app","rootPath":"/docs"}]';

  it('lists the newest patch of every archived minor, newest first', async () => {
    expect(await get('/v1/docs/versions')).toEqual({
      status: 200,
      headers: DOCS_HEADERS,
      timing: 'version_d1_get_docs_versions, version_docs_versions_request, version_handle_request',
      body: ARCHIVED,
    });
  });

  it('accepts any method', async () => {
    expect(await get('/v1/docs/versions', { method: 'POST' })).toEqual({
      status: 200,
      headers: DOCS_HEADERS,
      timing: ANY_TIMING,
      body: ARCHIVED,
    });
  });

  it('serves an empty list when nothing is stored', async () => {
    await clear();
    expect(await get('/v1/docs/versions')).toEqual({
      status: 200,
      headers: DOCS_HEADERS,
      timing: ANY_TIMING,
      body: '[]',
    });
  });
});

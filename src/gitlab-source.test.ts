import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabReleasesSource } from './gitlab-source.js';
import { RateLimitError, SourceHttpError } from './sources.js';
import futoNotes from './test/fixtures/gitlab-futo-notes-releases.json';
import { gitlabReleasesPage } from './test/helpers.js';

// futoNotes is GitLab's listing of futo-notes/futo-notes on 2026-10-06, newest
// released first, with each release's author, commit, assets, evidences and
// links trimmed off.
const RELEASES = 'https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/releases';

const source = (timeoutMs?: number) => new GitLabReleasesSource('gitlab.futo.org', 'futo-notes/futo-notes', timeoutMs);

// A listing of `count` releases, newest first.
const listing = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    tag_name: `v0.0.${count - index}`,
    released_at: new Date(Date.UTC(2025, 0, 1) + (count - index) * 60_000).toISOString(),
    upcoming_release: false,
  }));

// Answers the project's releases URL, a page at a time as GitLab does, or with
// `answer` when given; records every request.
function mockGitLab(releases: readonly unknown[], answer?: (url: URL) => Response) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (!request.url.startsWith(`${RELEASES}?`)) {
      return Promise.reject(new Error(`unexpected fetch: ${request.url}`));
    }
    return Promise.resolve(answer ? answer(new URL(request.url)) : gitlabReleasesPage(request.url, releases));
  });
  return requests;
}

// A request that only ends when its signal aborts, as fetch's does.
function mockHangingGitLab() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
        }
        signal?.addEventListener('abort', () => reject(signal.reason));
      }),
  );
}

describe('GitLabReleasesSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the project's 20 newest releases from the public API, without a token", async () => {
    const requests = mockGitLab(futoNotes);

    const releases = await source().fetchRecent();

    expect(requests.map(({ url }) => url)).toEqual([`${RELEASES}?per_page=20`]);
    expect(requests[0].headers.get('User-Agent')).toBe('futo-version-service');
    expect(requests[0].headers.get('Authorization')).toBeNull();
    expect(releases).toHaveLength(20);
    // The release date is released_at, and the tag is the release's id: the API gives it none.
    expect(releases[0]).toEqual({
      tag: 'v1.8.0',
      published_at: '2026-09-17T18:39:18.938Z',
      source_id: 'v1.8.0',
      forge_prerelease: null,
    });
    // In GitLab's order, by release date: putting versions in order is the project's scheme's job.
    expect(releases.map(({ tag }) => tag).slice(10, 12)).toEqual(['v1.4.0', 'v1.4.1']);
  });

  it('lists every release in one page when they fit, and says that was all of them', async () => {
    const requests = mockGitLab(futoNotes);

    const { releases, complete } = await source().fetchAll();

    expect(requests.map(({ url }) => url)).toEqual([`${RELEASES}?per_page=100&page=1`]);
    expect(complete).toBe(true);
    // Every tag, v0.0.1-test included: which ones are the project's is its pattern's call.
    expect(releases.map(({ tag }) => tag)).toEqual(futoNotes.map(({ tag_name }) => tag_name));
  });

  it('follows x-next-page until GitLab leaves it empty', async () => {
    const requests = mockGitLab(listing(150));

    const { releases, complete } = await source().fetchAll();

    expect(requests.map(({ url }) => url)).toEqual([
      `${RELEASES}?per_page=100&page=1`,
      `${RELEASES}?per_page=100&page=2`,
    ]);
    expect(releases).toHaveLength(150);
    expect(complete).toBe(true);
  });

  it('stops at 3 pages and says the listing is incomplete', async () => {
    const requests = mockGitLab(listing(301));

    const { releases, complete } = await source().fetchAll();

    expect(requests).toHaveLength(3);
    expect(releases).toHaveLength(300);
    expect(complete).toBe(false);
  });

  it.each([
    ['skips a page', '3'],
    ['names a page already listed', '1'],
    ['names no page', 'two'],
  ])('stops, and says the listing is incomplete, when x-next-page %s', async (_, next) => {
    // Page 1 names `next`, and page 3 says it is the last: followed, a jump
    // would pass for the whole listing without page 2.
    const requests = mockGitLab([], (url) =>
      url.searchParams.get('page') === '1'
        ? Response.json(listing(100), { headers: { 'x-next-page': next } })
        : Response.json([], { headers: { 'x-next-page': '' } }),
    );

    const { releases, complete } = await source().fetchAll();

    expect(requests.map(({ url }) => url)).toEqual([`${RELEASES}?per_page=100&page=1`]);
    expect(releases).toHaveLength(100);
    expect(complete).toBe(false);
  });

  it("drops a release that isn't out yet, and anything that isn't a release", async () => {
    const upcoming = { ...futoNotes[0], tag_name: 'v1.9.0', released_at: '2099-01-01T00:00:00.000Z' };
    mockGitLab([{ ...upcoming, upcoming_release: true }, { message: 'not a release' }, ...futoNotes]);

    const recent = await source().fetchRecent();
    const { releases } = await source().fetchAll();

    expect(recent[0].tag).toBe('v1.8.0');
    expect(releases).toHaveLength(futoNotes.length);
  });

  it("fails rather than guess whether the listing is complete when a page doesn't name the next one", async () => {
    mockGitLab([], () => Response.json(futoNotes));

    await expect(source().fetchAll()).rejects.toThrow(/did not say which page is next/);
    // One page needs no next one.
    expect(await source().fetchRecent()).toHaveLength(futoNotes.length);
  });

  it('fails on a response that is not a listing', async () => {
    mockGitLab([], () => Response.json({ message: 'not a listing' }));

    await expect(source().fetchRecent()).rejects.toThrow(/did not list releases/);
  });

  it('encodes a path with subgroups as one segment', async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      requests.push(new Request(input, init).url);
      return Promise.resolve(Response.json([]));
    });

    await new GitLabReleasesSource('gitlab.example.org', 'group/sub.group/name').fetchRecent();

    expect(requests).toEqual([
      'https://gitlab.example.org/api/v4/projects/group%2Fsub.group%2Fname/releases?per_page=20',
    ]);
  });

  it('shares a rate limit with every project on its host, and with no other', () => {
    const other = new GitLabReleasesSource('gitlab.futo.org', 'futo-org/other');
    const elsewhere = new GitLabReleasesSource('gitlab.example.org', 'futo-notes/futo-notes');

    expect(source().rateLimitKey).toBe('gitlab-anonymous:gitlab.futo.org');
    expect(other.rateLimitKey).toBe(source().rateLimitKey);
    expect(elsewhere.rateLimitKey).not.toBe(source().rateLimitKey);
  });

  it.each([
    ['a 429', new Response(null, { status: 429, headers: { 'Retry-After': '60' } }), RateLimitError],
    ['a 401', new Response(null, { status: 401 }), SourceHttpError],
    ['a 403', new Response(null, { status: 403 }), SourceHttpError],
    // GitLab's answer for a project that doesn't exist, or isn't public.
    ['a 404', Response.json({ message: '404 Project Not Found' }, { status: 404 }), SourceHttpError],
    ['a 500', new Response(null, { status: 500 }), SourceHttpError],
  ])('throws on %s', async (_, response, type) => {
    mockGitLab([], () => response);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = source().fetchRecent();

    await expect(failure).rejects.toBeInstanceOf(type);
    await expect(failure).rejects.toMatchObject(
      type === SourceHttpError ? { status: response.status } : { retryAfter: '60' },
    );
  });

  it('gives up on a request after its timeout', async () => {
    mockHangingGitLab();

    await expect(source(20).fetchAll()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("gives up when the caller's signal aborts", async () => {
    mockHangingGitLab();
    const controller = new AbortController();

    const failure = source().fetchRecent({ signal: controller.signal });
    controller.abort(new DOMException('deadline', 'TimeoutError'));

    await expect(failure).rejects.toMatchObject({ name: 'TimeoutError', message: 'deadline' });
  });
});

// A stored GitLab release, whose source id is its tag.
const candidate = (tag: string) => ({
  tag,
  published_at: '2025-01-01T00:00:00.000Z',
  source_id: tag,
  forge_prerelease: null,
});

// GitLab's release of `tag`, as the API answers for one release.
const releaseOf = (tag: string, extra: Record<string, unknown> = {}) =>
  Response.json({ ...futoNotes[0], tag_name: tag, ...extra });

// Answers each URL of one release with its response, recording every request;
// any other request fails as the network would.
function mockGitLabReleases(answers: Record<string, Response>) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const answer = answers[request.url];
    return answer ? Promise.resolve(answer) : Promise.reject(new TypeError('Network connection lost.'));
  });
  return requests;
}

describe('GitLabReleasesSource.confirmRetracted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for each release by its tag, and confirms the ones GitLab no longer has', async () => {
    const requests = mockGitLabReleases({
      [`${RELEASES}/v1.7.9`]: Response.json({ message: '404 Not Found' }, { status: 404 }),
      [`${RELEASES}/v1.8.0`]: releaseOf('v1.8.0'),
      [`${RELEASES}/release%2F1.0`]: Response.json({ message: '404 Not Found' }, { status: 404 }),
    });

    const gone = await source().confirmRetracted([candidate('v1.7.9'), candidate('v1.8.0'), candidate('release/1.0')]);

    expect(gone).toEqual([candidate('v1.7.9'), candidate('release/1.0')]);
    expect(requests.map(({ url }) => url)).toEqual([
      `${RELEASES}/v1.7.9`,
      `${RELEASES}/v1.8.0`,
      `${RELEASES}/release%2F1.0`,
    ]);
    expect(requests[0].headers.get('User-Agent')).toBe('futo-version-service');
    expect(requests[0].headers.get('Authorization')).toBeNull();
  });

  it('confirms a release that is upcoming again, which a listing skips too', async () => {
    mockGitLabReleases({
      [`${RELEASES}/v1.8.0`]: releaseOf('v1.8.0', { released_at: '2099-01-01T00:00:00.000Z', upcoming_release: true }),
    });

    expect(await source().confirmRetracted([candidate('v1.8.0')])).toEqual([candidate('v1.8.0')]);
  });

  it.each([
    ['a 500', new Response(null, { status: 500 })],
    ['a 403', new Response(null, { status: 403 })],
    ['a body that is not its release', Response.json({ message: 'Moved' })],
    ['a failed request', undefined],
  ])('keeps a release on %s, and asks about the rest', async (_, response) => {
    mockGitLabReleases({
      ...(response && { [`${RELEASES}/v1.7.9`]: response }),
      [`${RELEASES}/v1.7.8`]: new Response(null, { status: 404 }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await source().confirmRetracted([candidate('v1.7.9'), candidate('v1.7.8')])).toEqual([candidate('v1.7.8')]);
    expect(error).toHaveBeenCalledWith(
      '[version] gitlab.futo.org/futo-notes/futo-notes: kept v1.7.9, which could not be confirmed gone:',
      expect.anything(),
    );
  });

  it('keeps a release whose request times out', async () => {
    mockHangingGitLab();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await source(20).confirmRetracted([candidate('v1.8.0')])).toEqual([]);
  });

  it('gives up on the checks once they have taken their budget, and keeps the rest', async () => {
    mockHangingGitLab();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const gone = source().confirmRetracted([candidate('v1.8.0'), candidate('v1.7.9')], { budgetMs: 20 });

    expect(await gone).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('stops at a 429 and throws it, so the run skips the host', async () => {
    const requests = mockGitLabReleases({
      [`${RELEASES}/v1.7.9`]: new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = source().confirmRetracted([candidate('v1.7.9'), candidate('v1.7.8')]);

    await expect(failure).rejects.toBeInstanceOf(RateLimitError);
    expect(requests).toHaveLength(1);
  });

  it("gives up when the caller's signal aborts", async () => {
    mockHangingGitLab();
    const controller = new AbortController();

    const failure = source().confirmRetracted([candidate('v1.8.0'), candidate('v1.7.9')], {
      signal: controller.signal,
    });
    controller.abort(new DOMException('deadline', 'TimeoutError'));

    await expect(failure).rejects.toMatchObject({ name: 'TimeoutError', message: 'deadline' });
  });
});

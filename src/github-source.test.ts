import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubTokens, type GitHubCredentials } from './github-auth.js';
import { GitHubReleasesSource } from './github-source.js';
import { errorClass, RateLimitError, SourceAuthError, SourceHttpError } from './sources.js';
import { githubAppAnswer, githubAppPrivateKey } from './test/helpers.js';

// futo-org/example, by its id.
const REPOSITORY = { repo: 'futo-org/example', repoId: 1 };
const RELEASES = 'https://api.github.com/repositories/1/releases';

const anonymous: GitHubCredentials = { rateLimitKey: 'github-anonymous', token: () => Promise.resolve(undefined) };

const githubRelease = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  tag_name: `v1.${id}.0`,
  published_at: `2025-01-${String(id).padStart(2, '0')}T00:00:00Z`,
  ...extra,
});

// Answers each GitHub URL with its listing, recording every request.
function mockGitHub(pages: Record<string, unknown>) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const body = pages[request.url];
    return body === undefined
      ? Promise.reject(new Error(`unexpected fetch: ${request.url}`))
      : Promise.resolve(body instanceof Response ? body : Response.json(body));
  });
  return requests;
}

// A request that only ends when its signal aborts, as fetch's does.
function mockHangingGitHub() {
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

// A body that fails before it ends, as when the connection resets.
function cutOff() {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error('connection reset'));
    },
  });
}

// Answers a GitHub App's requests as GitHub does, with the app installed on
// these owners, recording every request.
function mockGitHubApp(installations: Record<string, number>) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const answer = githubAppAnswer(request, installations);
    return answer ? Promise.resolve(answer) : Promise.reject(new Error(`unexpected fetch: ${request.url}`));
  });
  return requests;
}

// mockGitHubApp, except that the lookups of these repositories answer as given.
function mockGitHubAppWith(installations: Record<string, number>, lookups: Record<string, () => Response>) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const repo = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(request.url)?.[1];
    const answer = (repo && lookups[repo]?.()) || githubAppAnswer(request, installations);
    return answer ? Promise.resolve(answer) : Promise.reject(new Error(`unexpected fetch: ${request.url}`));
  });
  return requests;
}

const lookupsOf = (requests: Request[]) => requests.filter(({ url }) => url.endsWith('/installation'));

// A JWT's claims, read without checking its signature.
const jwtClaims = (authorization: string | null) =>
  JSON.parse(
    atob(
      authorization!
        .replace(/^bearer /i, '')
        .split('.', 2)[1]
        .replaceAll('-', '+')
        .replaceAll('_', '/'),
    ),
  );

describe('GitHubReleasesSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the repository's 20 newest releases, keeping prereleases and dropping drafts", async () => {
    const requests = mockGitHub({
      [`${RELEASES}?per_page=20`]: [
        githubRelease(3, { draft: true, published_at: null }),
        githubRelease(2, { prerelease: true }),
        githubRelease(1),
        { id: 'not a release' },
      ],
    });

    const releases = await new GitHubReleasesSource(REPOSITORY, anonymous).fetchRecent();

    expect(releases).toEqual([
      { tag: 'v1.2.0', published_at: '2025-01-02T00:00:00Z', source_id: '2', forge_prerelease: true },
      { tag: 'v1.1.0', published_at: '2025-01-01T00:00:00Z', source_id: '1', forge_prerelease: false },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('User-Agent')).toBe('futo-version-service');
    expect(requests[0].headers.get('Authorization')).toBeNull();
  });

  it('reads the repository by its id, never by its name, which another repository can take', async () => {
    const requests = mockGitHub({
      'https://api.github.com/repos/futo-org/example/releases?per_page=20': [githubRelease(9)],
      [`${RELEASES}?per_page=20`]: [githubRelease(1)],
    });

    const releases = await new GitHubReleasesSource(REPOSITORY, anonymous).fetchRecent();

    expect(releases.map(({ tag }) => tag)).toEqual(['v1.1.0']);
    expect(requests.map(({ url }) => url)).toEqual([`${RELEASES}?per_page=20`]);
  });

  it('reads with the installation token', async () => {
    const requests = mockGitHub({ [`${RELEASES}?per_page=20`]: [] });
    const credentials = { rateLimitKey: 'github-installation:1', token: () => Promise.resolve('secret') };

    const source = new GitHubReleasesSource(REPOSITORY, credentials);
    await source.fetchRecent();

    expect(requests[0].headers.get('Authorization')).toBe('Bearer secret');
    expect(source.rateLimitKey).toBe('github-installation:1');
  });

  it('lists every release a page at a time, and says when that was all of them', async () => {
    const full = Array.from({ length: 100 }, (_, index) => githubRelease(index + 2));
    const requests = mockGitHub({
      [`${RELEASES}?per_page=100&page=1`]: full,
      [`${RELEASES}?per_page=100&page=2`]: [githubRelease(1)],
    });

    const { releases, complete } = await new GitHubReleasesSource(REPOSITORY, anonymous).fetchAll();

    expect(releases).toHaveLength(101);
    expect(complete).toBe(true);
    expect(requests.map(({ url }) => url)).toEqual([
      `${RELEASES}?per_page=100&page=1`,
      `${RELEASES}?per_page=100&page=2`,
    ]);
  });

  it('counts a page as full by its listed items, drafts included', async () => {
    const page = [
      githubRelease(1, { draft: true }),
      ...Array.from({ length: 99 }, (_, index) => githubRelease(index + 2)),
    ];
    const requests = mockGitHub({
      [`${RELEASES}?per_page=100&page=1`]: page,
      [`${RELEASES}?per_page=100&page=2`]: [],
    });

    const { releases, complete } = await new GitHubReleasesSource(REPOSITORY, anonymous).fetchAll();

    expect(releases).toHaveLength(99);
    expect(complete).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('stops at 3 pages and says the listing is incomplete', async () => {
    const full = Array.from({ length: 100 }, (_, index) => githubRelease(index + 1));
    const requests = mockGitHub({
      [`${RELEASES}?per_page=100&page=1`]: full,
      [`${RELEASES}?per_page=100&page=2`]: full,
      [`${RELEASES}?per_page=100&page=3`]: full,
    });

    const { releases, complete } = await new GitHubReleasesSource(REPOSITORY, anonymous).fetchAll();

    expect(releases).toHaveLength(300);
    expect(complete).toBe(false);
    expect(requests).toHaveLength(3);
  });

  it.each([
    ['a 429', new Response(null, { status: 429, headers: { 'Retry-After': '60' } }), RateLimitError],
    [
      'a 403 with no requests left',
      new Response(null, { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }),
      RateLimitError,
    ],
    [
      'a 403 that says when to retry',
      new Response(null, { status: 403, headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': '4999' } }),
      RateLimitError,
    ],
    [
      'a 403 for a secondary rate limit, with requests left',
      Response.json(
        { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        { status: 403, headers: { 'X-RateLimit-Remaining': '4999' } },
      ),
      RateLimitError,
    ],
    [
      'any other 403',
      Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }),
      SourceHttpError,
    ],
    [
      'a 403 with no requests left, whose message is cut off',
      new Response(cutOff(), { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }),
      RateLimitError,
    ],
    ['any other 403, whose message is cut off', new Response(cutOff(), { status: 403 }), SourceHttpError],
    ['a 404', new Response(null, { status: 404 }), SourceHttpError],
    ['a 500', new Response(null, { status: 500 }), SourceHttpError],
  ])('throws on %s', async (_, response, type) => {
    mockGitHub({ [`${RELEASES}?per_page=20`]: response });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failure = new GitHubReleasesSource(REPOSITORY, anonymous).fetchRecent();

    await expect(failure).rejects.toBeInstanceOf(type);
    await expect(failure).rejects.toMatchObject(type === SourceHttpError ? { status: response.status } : {});
  });

  it('gives up on a request after its timeout', async () => {
    mockHangingGitHub();

    const failure = new GitHubReleasesSource(REPOSITORY, anonymous, 20).fetchAll();

    await expect(failure).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("gives up when the caller's signal aborts", async () => {
    mockHangingGitHub();
    const controller = new AbortController();

    const failure = new GitHubReleasesSource(REPOSITORY, anonymous).fetchRecent({ signal: controller.signal });
    controller.abort(new DOMException('deadline', 'TimeoutError'));

    await expect(failure).rejects.toMatchObject({ name: 'TimeoutError', message: 'deadline' });
  });
});

// githubRelease(id) as it was stored, for confirmRetracted() to ask about.
const candidate = (id: number) => ({
  tag: `v1.${id}.0`,
  published_at: '2025-01-01T00:00:00Z',
  source_id: String(id),
  forge_prerelease: false,
});

// Asks an anonymous source about the candidates.
const confirm = (candidates: ReturnType<typeof candidate>[], signal?: AbortSignal, timeoutMs?: number) =>
  new GitHubReleasesSource(REPOSITORY, anonymous, timeoutMs).confirmRetracted(candidates, { signal });

describe('GitHubReleasesSource.confirmRetracted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for each release by its id, and confirms the ones GitHub no longer has', async () => {
    const requests = mockGitHub({
      [`${RELEASES}/1`]: Response.json({ message: 'Not Found' }, { status: 404 }),
      [`${RELEASES}/2`]: githubRelease(2),
    });
    const credentials = { rateLimitKey: 'github-installation:1', token: () => Promise.resolve('secret') };

    const gone = await new GitHubReleasesSource(REPOSITORY, credentials).confirmRetracted([candidate(1), candidate(2)]);

    expect(gone).toEqual([candidate(1)]);
    expect(requests.map(({ url }) => url)).toEqual([`${RELEASES}/1`, `${RELEASES}/2`]);
    expect(requests[0].headers.get('User-Agent')).toBe('futo-version-service');
    expect(requests[0].headers.get('Authorization')).toBe('Bearer secret');
  });

  it('confirms a release turned back into a draft, and one that now has another tag', async () => {
    mockGitHub({
      [`${RELEASES}/1`]: githubRelease(1, { draft: true, published_at: null }),
      [`${RELEASES}/2`]: githubRelease(2, { tag_name: 'v2.0.0' }),
      [`${RELEASES}/3`]: githubRelease(3, { prerelease: true }),
    });

    expect(await confirm([candidate(1), candidate(2), candidate(3)])).toEqual([candidate(1), candidate(2)]);
  });

  it.each([
    ['a 500', new Response(null, { status: 500 })],
    [
      'a 403 that denies the request',
      Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }),
    ],
    ['a body that is not a release', Response.json({ message: 'Moved' })],
  ])('keeps a release on %s, and asks about the rest', async (_, response) => {
    mockGitHub({
      [`${RELEASES}/1`]: response,
      [`${RELEASES}/2`]: new Response(null, { status: 404 }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await confirm([candidate(1), candidate(2)])).toEqual([candidate(2)]);
    expect(error).toHaveBeenCalledWith(
      '[version] futo-org/example: kept v1.1.0, which could not be confirmed gone:',
      expect.anything(),
    );
  });

  it('keeps a release whose request fails or times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const { url, signal } = new Request(input, init);
      if (url === `${RELEASES}/1`) {
        return Promise.reject(new TypeError('Network connection lost.'));
      }
      // The second hangs until it times out; the third is gone.
      return url === `${RELEASES}/2`
        ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
        : Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await confirm([candidate(1), candidate(2), candidate(3)], undefined, 20)).toEqual([candidate(3)]);
  });

  it('keeps a release without a GitHub release id, without asking', async () => {
    const requests = mockGitHub({});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await confirm([{ ...candidate(1), source_id: '' }])).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each([
    ['a 429', new Response(null, { status: 429, headers: { 'Retry-After': '60' } })],
    [
      'a 403 for a secondary rate limit',
      Response.json(
        { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        { status: 403 },
      ),
    ],
  ])('stops at %s and throws it, so the run skips the rate limit', async (_, response) => {
    const requests = mockGitHub({ [`${RELEASES}/1`]: response });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(confirm([candidate(1), candidate(2)])).rejects.toBeInstanceOf(RateLimitError);
    expect(requests).toHaveLength(1);
  });

  it('gives up on the checks once they have taken their budget, and keeps the rest', async () => {
    mockHangingGitHub();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const gone = new GitHubReleasesSource(REPOSITORY, anonymous).confirmRetracted([candidate(1), candidate(2)], {
      budgetMs: 20,
    });

    expect(await gone).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("gives up when the caller's signal aborts", async () => {
    mockHangingGitHub();
    const controller = new AbortController();

    const failure = confirm([candidate(1), candidate(2)], controller.signal);
    controller.abort(new DOMException('deadline', 'TimeoutError'));

    await expect(failure).rejects.toMatchObject({ name: 'TimeoutError', message: 'deadline' });
  });
});

describe('GitHubTokens', () => {
  // The app's id, with a key octokit can sign its JWTs with.
  let app: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string };

  beforeAll(async () => {
    app = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: await githubAppPrivateKey() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads unauthenticated without the GitHub App bindings', async () => {
    const credentials = new GitHubTokens({}).forRepository('immich-app/immich');

    expect(credentials.rateLimitKey).toBe('github-anonymous');
    expect(await credentials.token()).toBeUndefined();
  });

  it("looks again for an owner's next repository after one the app isn't installed on", async () => {
    mockGitHubAppWith({ 'futo-org': 8 }, { 'futo-org/denied': () => Response.json({}, { status: 404 }) });
    const tokens = new GitHubTokens(app);

    await expect(tokens.forRepository('futo-org/denied').token()).rejects.toBeInstanceOf(SourceAuthError);
    expect(await tokens.forRepository('futo-org/allowed').token()).toBe('token-8');
  });

  it.each([
    ['a 429', () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } })],
    [
      'a 403 with no requests left',
      () => new Response(null, { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }),
    ],
  ])(
    'reports %s on the installation lookup as a rate limit, and looks up nothing more this run',
    async (_, limited) => {
      const requests = mockGitHubAppWith({ 'immich-app': 7, 'futo-org': 8 }, { 'futo-org/example': limited });
      const tokens = new GitHubTokens(app);
      expect(await tokens.forRepository('immich-app/immich').token()).toBe('token-7');

      let error: unknown;
      try {
        await tokens.forRepository('futo-org/example').token();
      } catch (error_) {
        error = error_;
      }
      expect(error).toBeInstanceOf(RateLimitError);
      expect(errorClass(error)).toBe('rate_limited');

      await expect(tokens.forRepository('futo-org/other').token()).rejects.toBeInstanceOf(RateLimitError);
      expect(lookupsOf(requests)).toHaveLength(2);
      // The owner already minted keeps its token.
      expect(await tokens.forRepository('immich-app/immich').token()).toBe('token-7');
    },
  );

  it("gives each owner its own installation's rate limit", () => {
    const tokens = new GitHubTokens(app);

    expect(tokens.forRepository('immich-app/immich').rateLimitKey).toBe('github-installation:immich-app');
    expect(tokens.forRepository('Immich-App/static-pages').rateLimitKey).toBe('github-installation:immich-app');
    expect(tokens.forRepository('futo-org/example').rateLimitKey).toBe('github-installation:futo-org');
  });

  it("reads each repository with its owner's installation, which the app finds with its JWT", async () => {
    const requests = mockGitHubApp({ 'immich-app': 7, 'futo-org': 8 });
    const tokens = new GitHubTokens(app);

    expect(await tokens.forRepository('immich-app/immich').token()).toBe('token-7');
    expect(await tokens.forRepository('futo-org/example').token()).toBe('token-8');

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET https://api.github.com/repos/immich-app/immich/installation',
      'POST https://api.github.com/app/installations/7/access_tokens',
      'GET https://api.github.com/repos/futo-org/example/installation',
      'POST https://api.github.com/app/installations/8/access_tokens',
    ]);
    expect(requests[0].headers.get('User-Agent')).toBe('futo-version-service');
    for (const request of requests) {
      expect(jwtClaims(request.headers.get('Authorization'))).toMatchObject({ iss: '1' });
    }
  });

  it("finds and mints an owner's token once per run, whichever of its repositories asks", async () => {
    const requests = mockGitHubApp({ 'immich-app': 7 });
    const tokens = new GitHubTokens(app);

    const first = tokens.forRepository('immich-app/immich').token();
    const second = tokens.forRepository('Immich-App/static-pages').token();

    expect(second).toBe(first);
    expect(await second).toBe('token-7');
    expect(requests).toHaveLength(2);
  });

  it("fails an owner the app isn't installed on as an auth error, and no other owner", async () => {
    mockGitHubApp({ 'immich-app': 7 });
    const tokens = new GitHubTokens(app);

    const failure = tokens.forRepository('futo-org/example').token();

    await expect(failure).rejects.toBeInstanceOf(SourceAuthError);
    await expect(failure).rejects.toThrow('GitHub App token: the app is not installed on futo-org/example');
    expect(await tokens.forRepository('immich-app/immich').token()).toBe('token-7');
  });

  it("fails as an auth error when the app's key is unusable", async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));

    const failure = new GitHubTokens({ ...app, GITHUB_APP_PRIVATE_KEY: 'not a key' })
      .forRepository('immich-app/immich')
      .token();

    await expect(failure).rejects.toBeInstanceOf(SourceAuthError);
    await expect(failure).rejects.toThrow(/^GitHub App token: /);
  });

  it('gives up on finding the installation after its timeout, as a timeout rather than an auth failure', async () => {
    mockHangingGitHub();

    const failure = new GitHubTokens(app, 20).forRepository('immich-app/immich').token();

    let error: unknown;
    try {
      await failure;
    } catch (error_) {
      error = error_;
    }
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(errorClass(error)).toBe('timeout');
  });
});

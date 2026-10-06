import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubTokens, type GitHubCredentials } from './github-auth.js';
import { GitHubReleasesSource } from './github-source.js';
import { errorClass, RateLimitError, SourceAuthError, SourceHttpError } from './sources.js';

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
  const app = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'not a key', GITHUB_APP_INSTALLATION_ID: '42' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads unauthenticated without the GitHub App bindings', async () => {
    const credentials = new GitHubTokens({}).forRepository('immich-app/immich');

    expect(credentials.rateLimitKey).toBe('github-anonymous');
    expect(await credentials.token()).toBeUndefined();
  });

  it("gives every repository the installation's rate limit, whatever its owner", () => {
    const tokens = new GitHubTokens(app);

    expect(tokens.forRepository('immich-app/immich').rateLimitKey).toBe('github-installation:42');
    expect(tokens.forRepository('futo-org/example').rateLimitKey).toBe('github-installation:42');
  });

  it('mints the token once per run, and fails as an auth error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
    const tokens = new GitHubTokens(app);
    const first = tokens.forRepository('immich-app/immich').token();
    const second = tokens.forRepository('futo-org/example').token();

    expect(second).toBe(first);
    await expect(first).rejects.toBeInstanceOf(SourceAuthError);
    await expect(first).rejects.toThrow(/^GitHub App token: /);
  });

  it('reports a mint that stalls past its deadline as a timeout, not an auth failure', async () => {
    // A real key, so the mint gets past signing to the request that stalls.
    const { privateKey } = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCodePoint(...der))}\n-----END PRIVATE KEY-----`;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(() => {}));

    const failure = new GitHubTokens({ ...app, GITHUB_APP_PRIVATE_KEY: pem }, 20)
      .forRepository('immich-app/immich')
      .token();

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

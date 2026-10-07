import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorker } from './index.js';
import { CloudflareMetricsRepository, type Metric } from './metrics.js';
import { legacyProject, loadProjects, requireProject, type Project } from './projects.js';
import type { IReleaseRepository } from './release-repository.js';
import type { ReleaseSource } from './sources.js';
import { syncProjects } from './sync.js';
import futoNotes from './test/fixtures/gitlab-futo-notes-releases.json';
import {
  clearReleases,
  fullSyncedAt,
  gitlabReleasesPage,
  loggedLines,
  runCron,
  seriesTags,
  storedReleases,
  storedTags,
} from './test/helpers.js';
import type { ProjectRelease } from './types.js';
import { versionCaches, VersionService } from './version-service.js';

// Immich, plus two projects under another owner. Tests pass this registry to
// createWorker() rather than edit projects.json.
const futoProjects = loadProjects({
  projects: ['notes', 'keyboard'].map((id, index) => ({
    id,
    name: id,
    source: { type: 'github-releases', repo: `futo-org/${id}`, repoId: index + 1 },
    tags: { pattern: String.raw`^v(?<version>\d+\.\d+\.\d+)$`, scheme: 'semver' },
    channels: { stable: [] },
    defaultChannel: 'stable',
    analytics: { clientIdentity: false },
    examples: { 'v1.0.0': { version: '1.0.0', channels: ['stable'] } },
  })),
});
const registry = [legacyProject, ...futoProjects];
// Each project's repository id, which GitHub is asked by.
const REPOS = { immich: 455_229_168, notes: 1, keyboard: 2 };
type Id = keyof typeof REPOS;

const releasesOf = (id: Id) => `https://api.github.com/repositories/${REPOS[id]}/releases`;
const full = (id: Id, page = 1) => `${releasesOf(id)}?per_page=100&page=${page}`;
const recent = (id: Id) => `${releasesOf(id)}?per_page=20`;
// One release, by its GitHub id.
const releaseOf = (id: Id, releaseId: number) => `${releasesOf(id)}/${releaseId}`;

// How a repository answers: its releases, an error status or response, or a
// request that only ends when it is aborted ('hang') or never ('stall').
type Answer = Record<string, unknown>[] | number | Response | 'hang' | 'stall';

const release = (id: number, tag: string) => ({ id, tag_name: tag, published_at: `2025-0${id}-01T00:00:00Z` });

/**
 * GitHub's answer from a repository's releases, newest first: a page of the
 * listing, by GitHub's offsets, or one release by its id, a 404 if it isn't
 * there.
 */
function fromReleases(url: string, releases: Record<string, unknown>[]): Response {
  const { pathname, searchParams } = new URL(url);
  const releaseId = /\/releases\/(\d+)$/.exec(pathname)?.[1];
  if (releaseId !== undefined) {
    const found = releases.find(({ id }) => String(id) === releaseId);
    return found ? Response.json(found) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  const perPage = Number(searchParams.get('per_page'));
  const page = Number(searchParams.get('page') ?? 1);
  return Response.json(releases.slice((page - 1) * perPage, page * perPage));
}

// Runs a cron with the registry above.
const run = (cron = '*/30 * * * *', options: Parameters<typeof createWorker>[0] = {}, bindings: Env = env) =>
  runCron(cron, { handler: createWorker({ projects: registry, ...options }), bindings });

describe('scheduled', () => {
  let answers: Record<Id, Answer>;
  // How GitHub answers a request for one release, by its URL, where a test
  // says. Otherwise it is the release its repository lists, or a 404.
  let releaseAnswers: Record<string, Answer>;
  // Called with each request GitHub has answered from a repository's releases.
  let afterAnswer: (url: string) => void;
  let requested: string[];
  // What had been logged when each request was made.
  let loggedBefore: Map<string, string>;
  let logged: string[];

  beforeEach(async () => {
    versionCaches.clear();
    await clearReleases();
    answers = { immich: [release(1, 'v1.120.0')], notes: [release(2, 'v1.0.0')], keyboard: [release(3, 'v2.0.0')] };
    releaseAnswers = {};
    afterAnswer = () => {};
    requested = [];
    logged = [];
    loggedBefore = new Map();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const { url, signal } = new Request(input, init);
      requested.push(url);
      loggedBefore.set(url, logged.join('\n'));
      const id = (Object.keys(REPOS) as Id[]).find((key) => url.startsWith(releasesOf(key)));
      const answer = id ? (releaseAnswers[url] ?? answers[id]) : undefined;
      if (answer === 'hang' || answer === 'stall') {
        return new Promise((_, reject) => {
          if (answer === 'hang') {
            signal.addEventListener('abort', () => reject(signal.reason));
          }
        });
      }
      if (typeof answer === 'number') {
        return Promise.resolve(new Response(null, { status: answer }));
      }
      if (answer instanceof Response) {
        return Promise.resolve(answer);
      }
      if (!answer) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }
      const response = fromReleases(url, answer);
      afterAnswer(url);
      return Promise.resolve(response);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const series = () => seriesTags(logged.flatMap((body) => body.split('\n')).filter((l) => l.startsWith('version_')));
  const errors = () => series().version_cron_error ?? [];

  it("syncs every registered project from its own repository, and only that project's tags", async () => {
    answers.notes = [release(2, 'v1.0.0'), release(1, 'notes-v1')];

    await run();

    expect(requested).toEqual([full('immich'), full('notes'), full('keyboard')]);
    expect(await storedTags('immich')).toEqual(['v1.120.0']);
    expect(await storedTags('notes')).toEqual(['v1.0.0']);
    expect(await storedTags('keyboard')).toEqual(['v2.0.0']);
    for (const id of Object.keys(REPOS)) {
      expect(await fullSyncedAt(id)).not.toBeNull();
    }
    expect(series().version_project_sync).toEqual([
      { version_project: 'immich' },
      { version_project: 'notes' },
      { version_project: 'keyboard' },
    ]);
    expect(errors()).toEqual([]);
  });

  it('lists only the newest releases of every project once each has had a full sync, and all of them nightly', async () => {
    await run();
    requested = [];

    await run();
    expect(requested).toEqual([recent('immich'), recent('notes'), recent('keyboard')]);

    requested = [];
    await run('0 3 * * *');
    expect(requested).toEqual([full('immich'), full('notes'), full('keyboard')]);
  });

  it('reads each repository by its registered id, even once another repository has taken its name', async () => {
    await run();
    // futo-org/notes was renamed, and a new repository took its old name.
    const taken = 'https://api.github.com/repos/futo-org/notes/releases';
    vi.mocked(fetch).mockImplementation(
      ((answer) => (input, init) => {
        const { url } = new Request(input, init);
        return url.startsWith(taken) ? Promise.resolve(Response.json([release(9, 'v9.0.0')])) : answer(input, init);
      })(vi.mocked(fetch).getMockImplementation()!),
    );
    requested = [];

    await run('0 3 * * *');

    expect(requested).toEqual([full('immich'), full('notes'), full('keyboard')]);
    expect(await storedTags('notes')).toEqual(['v1.0.0']);
    expect(errors()).toEqual([]);
  });

  it('nightly, deletes the unlisted releases GitHub confirms are gone, and keeps the rest', async () => {
    answers.notes = [release(4, 'v1.3.0'), release(3, 'v1.2.0'), release(2, 'v1.1.0'), release(1, 'v1.0.0')];
    await run();
    answers.notes = [release(4, 'v1.3.0')];
    // v1.2.0 was deleted (a 404), v1.1.0 can't be checked, and v1.0.0 is still published.
    releaseAnswers[releaseOf('notes', 2)] = 500;
    releaseAnswers[releaseOf('notes', 1)] = Response.json(release(1, 'v1.0.0'));
    requested = [];

    await run('0 3 * * *');

    expect(await storedTags('notes')).toEqual(['v1.0.0', 'v1.1.0', 'v1.3.0']);
    expect(requested).toEqual([
      full('immich'),
      full('notes'),
      releaseOf('notes', 3),
      releaseOf('notes', 2),
      releaseOf('notes', 1),
      full('keyboard'),
    ]);
    expect(errors()).toEqual([]);
    expect(await fullSyncedAt('notes')).not.toBeNull();
  });

  it('keeps the last release when one before it is deleted between the pages of a nightly listing', async () => {
    // 101 releases, newest first: a full page, and the oldest alone on the second.
    const listing = Array.from({ length: 101 }, (_, index) => ({
      id: 101 - index,
      tag_name: `v1.${100 - index}.0`,
      published_at: new Date(Date.UTC(2025, 0, 1) + (100 - index) * 86_400_000).toISOString(),
    }));
    answers.notes = listing;
    await run();
    expect(await storedTags('notes')).toHaveLength(101);

    // v1.99.0 is deleted once GitHub has answered the first page, so the second
    // starts a release later, and v1.0.0 is on neither.
    const deleted = listing[1];
    afterAnswer = (url) => {
      if (url === full('notes')) {
        answers.notes = listing.filter((item) => item !== deleted);
      }
    };
    requested = [];

    await run('0 3 * * *');

    // The listing reached its end, but GitHub still has v1.0.0.
    expect(requested.filter((url) => url.startsWith(releasesOf('notes')))).toEqual([
      full('notes'),
      full('notes', 2),
      releaseOf('notes', 1),
    ]);
    expect(await storedTags('notes')).toHaveLength(101);
    expect(await storedTags('notes')).toContain('v1.0.0');

    // The next nightly listing has it, and confirms v1.99.0 is gone.
    afterAnswer = () => {};
    requested = [];
    await run('0 3 * * *');

    expect(requested.filter((url) => url.startsWith(releasesOf('notes')))).toEqual([
      full('notes'),
      full('notes', 2),
      releaseOf('notes', deleted.id),
    ]);
    const stored = await storedTags('notes');
    expect(stored).toHaveLength(100);
    expect(stored).toContain('v1.0.0');
    expect(stored).not.toContain('v1.99.0');
    expect(errors()).toEqual([]);
  });

  it('skips the rest of the projects behind the token when it hits a rate limit while confirming', async () => {
    answers.notes = [release(2, 'v1.0.0'), release(1, 'v0.9.0')];
    await run();
    answers.notes = [release(2, 'v1.0.0')];
    releaseAnswers[releaseOf('notes', 1)] = 429;
    requested = [];

    await run('0 3 * * *');

    expect(requested).toEqual([full('immich'), full('notes'), releaseOf('notes', 1)]);
    expect(errors()).toEqual([
      { version_project: 'notes', error_class: 'rate_limited' },
      { version_project: 'keyboard', error_class: 'rate_limited' },
    ]);
    expect(await storedTags('notes')).toEqual(['v0.9.0', 'v1.0.0']);
  });

  it('keeps syncing the other projects when one fails, and counts the failure by its class', async () => {
    answers.notes = 500;

    await run();

    expect(await storedTags('immich')).toEqual(['v1.120.0']);
    expect(await storedTags('keyboard')).toEqual(['v2.0.0']);
    expect(await fullSyncedAt('notes')).toBeNull();
    expect(errors()).toEqual([{ version_project: 'notes', error_class: 'http' }]);
    // A failed sync still reports what is stored.
    expect(series().version_d1_release_count).toContainEqual({ version_project: 'notes' });
    expect(logged.join('\n')).toMatch(/^version_project_sync,\S*version_project=notes\S* \S*\berrors=1i/m);
  });

  it("reports every project's outcome on every run, so the latest one can be told apart", async () => {
    answers.notes = 500;
    await run();

    answers.notes = [release(2, 'v1.0.0')];
    await run();

    const outcomes = logged
      .flatMap((body) => body.split('\n'))
      .filter((line) => line.startsWith('version_project_sync_outcome,'))
      .map((line) => `${/version_project=(\w+)/.exec(line)![1]} ${/ failed=(\d)i/.exec(line)![1]}`);
    expect(outcomes).toEqual(['immich 0', 'notes 1', 'keyboard 0', 'immich 0', 'notes 0', 'keyboard 0']);
  });

  it('retries a failed full sync on the next run', async () => {
    answers.notes = 404;
    await run();
    expect(errors()).toEqual([{ version_project: 'notes', error_class: 'not_found' }]);

    answers.notes = [release(2, 'v1.0.0')];
    requested = [];
    await run();

    expect(requested).toContain(full('notes'));
    expect(await storedTags('notes')).toEqual(['v1.0.0']);
  });

  it('skips every project behind the same token once it hits a rate limit, whatever their owner', async () => {
    answers.immich = 429;

    await run();

    // Unauthenticated, every repository shares one rate limit.
    expect(requested).toEqual([full('immich')]);
    expect(errors()).toEqual([
      { version_project: 'immich', error_class: 'rate_limited' },
      { version_project: 'notes', error_class: 'rate_limited' },
      { version_project: 'keyboard', error_class: 'rate_limited' },
    ]);
  });

  it('skips them after a secondary rate limit too, which leaves requests remaining', async () => {
    answers.immich = Response.json(
      { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
      { status: 403, headers: { 'X-RateLimit-Remaining': '4999' } },
    );

    await run();

    expect(requested).toEqual([full('immich')]);
    expect(errors()).toEqual([
      { version_project: 'immich', error_class: 'rate_limited' },
      { version_project: 'notes', error_class: 'rate_limited' },
      { version_project: 'keyboard', error_class: 'rate_limited' },
    ]);
  });

  it('gives up on a hung request after its timeout, and moves on', async () => {
    answers.immich = 'hang';

    await run('*/30 * * * *', { requestTimeoutMs: 20 });

    expect(errors()).toEqual([{ version_project: 'immich', error_class: 'timeout' }]);
    expect(await storedTags('notes')).toEqual(['v1.0.0']);
    expect(await storedTags('keyboard')).toEqual(['v2.0.0']);
  });

  it('gives up on a project at its deadline, even when its work ignores the signal', async () => {
    answers.notes = 'stall';

    await run('*/30 * * * *', { projectDeadlineMs: 50 });

    expect(errors()).toEqual([{ version_project: 'notes', error_class: 'timeout' }]);
    expect(await storedTags('keyboard')).toEqual(['v2.0.0']);
  });

  it("ships the run's heartbeat before any project syncs, and each project's metrics before the next starts", async () => {
    answers.keyboard = 'stall';

    await run('*/30 * * * *', { projectDeadlineMs: 50 });

    expect(loggedBefore.get(full('immich'))).toMatch(/^version_cron_sync,\S* invocation=1i/m);
    expect(loggedBefore.get(full('notes'))).toMatch(/^version_project_sync,.*version_project=immich/m);
    expect(loggedBefore.get(full('keyboard'))).toMatch(/^version_project_sync,.*version_project=notes/m);
    // The run's duration follows once every project is done.
    expect(series().version_cron_sync).toEqual([{}, {}]);
  });

  it('fails every GitHub project as an auth error when the token cannot be minted, and still reports the run', async () => {
    const bindings = {
      ...env,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'not a key',
      GITHUB_APP_INSTALLATION_ID: '2',
    };

    await run('*/30 * * * *', {}, bindings);

    expect(requested.filter((url) => url.includes('/releases'))).toEqual([]);
    expect(errors()).toEqual([
      { version_project: 'immich', error_class: 'auth' },
      { version_project: 'notes', error_class: 'auth' },
      { version_project: 'keyboard', error_class: 'auth' },
    ]);
    expect(series().version_cron_sync).toEqual([{}, {}]);
  });

  it('reports the nightly run under its own name', async () => {
    await run('0 3 * * *');

    expect(series().version_cron_full_sync).toEqual([{}, {}]);
    expect(series().version_cron_sync).toBeUndefined();
  });
});

// Every project's source lists nothing, but notes' is down.
const notesDown = (project: Project): ReleaseSource => ({
  rateLimitKey: project.id,
  fetchRecent: () => (project.id === 'notes' ? Promise.reject(new Error('GitHub down')) : Promise.resolve([])),
  fetchAll: () => Promise.resolve({ releases: [], complete: true }),
  confirmRetracted: () => Promise.resolve([]),
});

describe('syncProjects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up on a project's release stats at the deadline, then ships its metrics and syncs the next", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pushed: Metric[] = [];
    // What each flush shipped, as "<project> <series>".
    const flushed: string[][] = [];
    const metrics = new CloudflareMetricsRepository('version', [
      {
        pushMetric: (metric) => {
          pushed.push(metric);
        },
        flush: () => {},
      },
    ]);
    // notes' sync fails, so its stats read what is stored, and that read never settles.
    let notesReads = 0;
    const repository = {
      list: vi.fn((projectId: string) =>
        projectId === 'notes' && ++notesReads > 1 ? new Promise<ProjectRelease[]>(() => {}) : Promise.resolve([]),
      ),
      upsertMany: vi.fn(() => Promise.resolve()),
      deleteMany: vi.fn(() => Promise.resolve(0)),
      now: vi.fn(() => Promise.resolve(new Date().toISOString())),
      getFullSyncedAt: vi.fn(() => Promise.resolve('earlier')),
      markFullSynced: vi.fn(() => Promise.resolve()),
    } satisfies IReleaseRepository;
    await syncProjects(registry, new VersionService(repository, metrics), metrics, {
      nightly: false,
      source: notesDown,
      deadlineMs: 50,
      afterProject: () => {
        flushed.push(pushed.splice(0).map((metric) => `${metric.tags.get('version_project')} ${metric.name}`));
      },
    });

    expect(flushed).toHaveLength(3);
    expect(flushed[1]).toEqual(
      expect.arrayContaining([
        'notes version_project_sync',
        'notes version_cron_error',
        'notes version_project_sync_outcome',
      ]),
    );
    expect(flushed[1]).not.toContain('notes version_d1_release_count');
    expect(flushed[2]).toContain('keyboard version_d1_release_count');
    expect(repository.list).toHaveBeenCalledWith('keyboard');
    expect(error).toHaveBeenCalledWith('[cron] notes: release stats failed (timeout):', expect.anything());
  });
});

describe('scheduled, with FUTO Notes on GitLab', () => {
  // FUTO Notes as projects.json registers it, synced from its real GitLab
  // releases (src/gitlab-source.test.ts).
  const notes = requireProject('futo-notes');
  const GITLAB = 'https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/releases';
  const URLS = { gitlab: GITLAB, github: 'https://api.github.com/repositories/455229168/releases' };

  // How each forge answers: its releases, an error status or, for GitLab, a
  // response to each request.
  let answers: {
    gitlab: readonly unknown[] | number | ((url: URL) => Response);
    github: readonly unknown[] | number;
  };
  // How GitLab answers a request for one release, by its tag, where a test
  // says. Otherwise it is the release GitLab lists, or a 404.
  let gitlabReleases: Record<string, Response>;
  let requests: Request[];
  let logged: string[];

  beforeEach(async () => {
    versionCaches.clear();
    await clearReleases();
    answers = { gitlab: futoNotes, github: [release(1, 'v1.120.0')] };
    gitlabReleases = {};
    requests = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const forge = (['gitlab', 'github'] as const).find((key) => request.url.startsWith(URLS[key]));
      if (!forge) {
        return Promise.reject(new Error(`unexpected fetch: ${request.url}`));
      }
      // One of GitLab's releases, by its tag.
      const tag = forge === 'gitlab' ? /^\/([^/?]+)$/.exec(request.url.slice(GITLAB.length))?.[1] : undefined;
      if (tag !== undefined && gitlabReleases[decodeURIComponent(tag)]) {
        return Promise.resolve(gitlabReleases[decodeURIComponent(tag)]);
      }
      const answer = answers[forge];
      if (typeof answer === 'number') {
        return Promise.resolve(new Response(null, { status: answer }));
      }
      if (typeof answer === 'function') {
        return Promise.resolve(answer(new URL(request.url)));
      }
      if (tag !== undefined) {
        const listed = (answer as { tag_name: string }[]).find(({ tag_name }) => tag_name === decodeURIComponent(tag));
        return Promise.resolve(
          listed ? Response.json(listed) : Response.json({ message: '404 Not Found' }, { status: 404 }),
        );
      }
      return Promise.resolve(
        forge === 'gitlab' ? gitlabReleasesPage(request.url, answer) : Response.json(answer.slice(0, 20)),
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Runs a cron, */30 unless told otherwise, over Immich and FUTO Notes, and returns its failures.
  const run = async ({ cron = '*/30 * * * *', registry = [legacyProject, notes], bindings = env } = {}) => {
    const handler = createWorker({ projects: registry });
    logged = await loggedLines(() => runCron(cron, { handler, bindings }));
    return seriesTags(logged).version_cron_error ?? [];
  };

  it('syncs FUTO Notes from its public GitLab project without a token, and serves its newest version', async () => {
    expect(await run()).toEqual([]);

    const gitlab = requests.filter(({ url }) => url.startsWith(GITLAB));
    expect(gitlab.map(({ url }) => url)).toEqual([`${GITLAB}?per_page=100&page=1`]);
    expect(gitlab[0].headers.get('Authorization')).toBeNull();
    // Every release its pattern takes; v0.0.1-test isn't one.
    const tags = futoNotes.map(({ tag_name }) => tag_name).filter((tag) => tag !== 'v0.0.1-test');
    const stored = await storedReleases('futo-notes');
    expect(new Set(stored.map(({ tag }) => tag))).toEqual(new Set(tags));
    expect(await fullSyncedAt('futo-notes')).not.toBeNull();
    expect(stored.find(({ tag }) => tag === 'v1.8.0')).toMatchObject({
      published_at: '2026-09-17T18:39:18.938Z',
      source_id: 'v1.8.0',
      forge_prerelease: null,
    });

    // The next run lists the newest 20, and finds nothing to write.
    requests = [];
    await run();
    expect(requests.map(({ url }) => url)).toContain(`${GITLAB}?per_page=20`);
    expect(logged.join('\n')).toMatch(/^version_releases_written,\S*version_project=futo-notes\S* count=0i/m);

    // Through the worker's own entrypoint, which serves what projects.json registers.
    const response = await exports.default.fetch('https://example.com/v1/projects/futo-notes/version');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project: 'futo-notes',
      channel: 'stable',
      version: '1.8.0',
      tag: 'v1.8.0',
      published_at: '2026-09-17T18:39:18.938Z',
    });
  });

  it('serves v1.4.1 over v1.4.0, which was released a month after it', async () => {
    // The listing on the day v1.4.0 came out. GitLab lists by release date, so it comes first.
    const released = (release: (typeof futoNotes)[number]) => Date.parse(release.released_at);
    const day = released(futoNotes.find(({ tag_name }) => tag_name === 'v1.4.0')!);
    answers.gitlab = futoNotes.filter((release) => released(release) <= day);
    expect(answers.gitlab.slice(0, 2)).toMatchObject([{ tag_name: 'v1.4.0' }, { tag_name: 'v1.4.1' }]);

    expect(await run()).toEqual([]);

    const response = await exports.default.fetch('https://example.com/v1/projects/futo-notes/version');
    expect(await response.json()).toEqual({
      project: 'futo-notes',
      channel: 'stable',
      version: '1.4.1',
      tag: 'v1.4.1',
      published_at: '2026-05-12T23:18:52.972Z',
    });
  });

  it("syncs a GitLab project when GitHub's token can't be minted", async () => {
    const bindings = {
      ...env,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'not a key',
      GITHUB_APP_INSTALLATION_ID: '2',
    };

    expect(await run({ bindings })).toEqual([{ version_project: 'immich', error_class: 'auth' }]);
    expect(await fullSyncedAt('futo-notes')).not.toBeNull();
  });

  it("keeps one forge's rate limit from skipping the other's projects", async () => {
    answers.github = 429;
    expect(await run()).toEqual([{ version_project: 'immich', error_class: 'rate_limited' }]);
    expect(await fullSyncedAt('futo-notes')).not.toBeNull();

    await clearReleases();
    answers = { gitlab: 429, github: [release(1, 'v1.120.0')] };
    expect(await run({ registry: [notes, legacyProject] })).toEqual([
      { version_project: 'futo-notes', error_class: 'rate_limited' },
    ]);
    expect(await storedTags('immich')).toEqual(['v1.120.0']);
  });

  it('counts a GitLab project that is missing or private as not found', async () => {
    answers.gitlab = 404;

    expect(await run()).toEqual([{ version_project: 'futo-notes', error_class: 'not_found' }]);
    expect(await fullSyncedAt('futo-notes')).toBeNull();
    expect(await storedTags('immich')).toEqual(['v1.120.0']);
  });

  // GitLab's listing once v1.0.0 is taken down.
  const withoutV100 = futoNotes.filter(({ tag_name }) => tag_name !== 'v1.0.0');
  // Page 1 of that listing names `next` after it. Any other page is the last,
  // or fails with `status`.
  const pagedAs =
    (next: string, status?: number) =>
    (url: URL): Response => {
      if (url.searchParams.get('page') === '1') {
        return Response.json(withoutV100, { headers: { 'x-next-page': next } });
      }
      return status ? new Response(null, { status }) : Response.json([], { headers: { 'x-next-page': '' } });
    };

  it('deletes the releases a nightly GitLab listing left out once GitLab confirms they are gone, and keeps the rest', async () => {
    await run();
    // v1.0.0 was deleted. GitLab still has v0.1.7, and v0.1.6 is upcoming again.
    answers.gitlab = futoNotes.filter(({ tag_name }) => !['v1.0.0', 'v0.1.7', 'v0.1.6'].includes(tag_name));
    const [v017, v016] = ['v0.1.7', 'v0.1.6'].map((tag) => futoNotes.find(({ tag_name }) => tag_name === tag)!);
    gitlabReleases['v0.1.7'] = Response.json(v017);
    gitlabReleases['v0.1.6'] = Response.json({
      ...v016,
      released_at: '2099-01-01T00:00:00.000Z',
      upcoming_release: true,
    });
    requests = [];

    expect(await run({ cron: '0 3 * * *' })).toEqual([]);

    expect(requests.map(({ url }) => url).filter((url) => url.startsWith(GITLAB))).toEqual([
      `${GITLAB}?per_page=100&page=1`,
      `${GITLAB}/v1.0.0`,
      `${GITLAB}/v0.1.7`,
      `${GITLAB}/v0.1.6`,
    ]);
    const tags = await storedTags('futo-notes');
    expect(tags).toContain('v0.1.7');
    expect(tags).not.toContain('v1.0.0');
    expect(tags).not.toContain('v0.1.6');
    expect(logged.join('\n')).toMatch(/^version_releases_deleted,\S*version_project=futo-notes\S* count=2i/m);
  });

  it.each([
    ['skips a page', pagedAs('3'), []],
    ['names a page already listed', pagedAs('1'), []],
    ['fails past its first page', pagedAs('2', 500), [{ version_project: 'futo-notes', error_class: 'http' }]],
  ])('takes nothing down on a nightly sync whose GitLab listing %s', async (_, answer, errors) => {
    await run();
    const stored = await storedReleases('futo-notes');
    expect(stored.map(({ tag }) => tag)).toContain('v1.0.0');

    answers.gitlab = answer;
    expect(await run({ cron: '0 3 * * *' })).toEqual(errors);
    expect(await storedReleases('futo-notes')).toEqual(stored);

    // The listing without v1.0.0, complete, does take it down.
    answers.gitlab = withoutV100;
    expect(await run({ cron: '0 3 * * *' })).toEqual([]);
    expect(await storedTags('futo-notes')).toEqual(stored.map(({ tag }) => tag).filter((tag) => tag !== 'v1.0.0'));
  });
});

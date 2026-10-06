import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredRepository } from './deferred.js';
import type { IGitHubRepository } from './github-repository.js';
import { type IMetricsRepository, Metric } from './metrics.js';
import type { AsyncFn, Operation } from './monitor.js';
import { legacyProject, loadProjects, type Project } from './projects.js';
import type { IReleaseRepository } from './release-repository.js';
import type { GitHubRelease, ProjectRelease } from './types.js';
import { changedReleases, versionCaches, VersionService } from './version-service.js';

class FakeMetrics implements IMetricsRepository {
  pushed: Metric[] = [];

  monitorAsyncFunction<T extends AsyncFn>(_operation: Operation, call: T) {
    return (...args: Parameters<T>) => call(...args) as Promise<Awaited<ReturnType<T>>>;
  }

  push(metric: Metric): void {
    this.pushed.push(metric);
  }

  names(): string[] {
    return this.pushed.map((metric) => metric.name);
  }

  find(name: string): Metric | undefined {
    return this.pushed.find((metric) => metric.name === name);
  }

  countOf(name: string): number | undefined {
    return this.find(name)?.fields.get('count')?.value;
  }
}

class FakeDeferred {
  calls: (() => Promise<unknown>)[] = [];

  defer(call: () => Promise<unknown>) {
    this.calls.push(call);
  }

  async run() {
    await Promise.all(this.calls.splice(0).map((call) => call()));
  }
}

const immich = legacyProject;

// A second project with the same tags as Immich, plus -rcN prereleases.
const [other] = loadProjects({
  projects: [
    {
      id: 'other',
      name: 'Other',
      source: { type: 'github-releases', repo: 'futo-org/other', repoId: 1 },
      tags: { pattern: String.raw`^v(?<version>\d+\.\d+\.\d+(?:-rc\d+)?)$`, scheme: 'semver' },
      channels: { stable: [], rc: ['rc'] },
      defaultChannel: 'stable',
      analytics: { clientIdentity: false },
      examples: { 'v1.0.0': { version: '1.0.0', channels: ['stable', 'rc'] } },
    },
  ],
});

const release: GitHubRelease = {
  id: 4,
  tag_name: 'v1.130.0',
  published_at: '2025-04-01T00:00:00Z',
  prerelease: false,
};

const stored = (tag: string, published_at = '', source_id = '1', forge_prerelease: boolean | null = false) =>
  ({ tag, published_at, source_id, forge_prerelease }) satisfies ProjectRelease;

const storedRelease = stored('v1.130.0', '2025-04-01T00:00:00Z', '4');

// An in-memory IReleaseRepository, one list of rows per project. Unless the
// test says otherwise, Immich has v1.130.0 and has had a full sync.
function createReleaseRepository(rows?: Record<string, ProjectRelease[]>, fullySynced = rows ? [] : ['immich']) {
  const data = new Map(Object.entries(rows ?? { immich: [storedRelease] }).map(([id, list]) => [id, [...list]]));
  const syncedAt = new Map<string, string>(fullySynced.map((id) => [id, 'earlier']));
  return {
    list: vi.fn((projectId: string) => Promise.resolve([...(data.get(projectId) ?? [])])),
    upsertMany: vi.fn((projectId: string, releases: readonly ProjectRelease[]) => {
      const kept = (data.get(projectId) ?? []).filter((row) => releases.every(({ tag }) => tag !== row.tag));
      data.set(projectId, [...kept, ...releases]);
      return Promise.resolve();
    }),
    getFullSyncedAt: vi.fn((projectId: string) => Promise.resolve(syncedAt.get(projectId) ?? null)),
    markFullSynced: vi.fn((projectId: string) => {
      syncedAt.set(projectId, 'now');
      return Promise.resolve();
    }),
  } satisfies IReleaseRepository;
}

function createGitHubRepository(overrides: Partial<IGitHubRepository> = {}): IGitHubRepository {
  return {
    fetchLatestRelease: vi.fn(() => Promise.resolve<GitHubRelease | null>(release)),
    fetchReleases: vi.fn(() => Promise.resolve([release])),
    ...overrides,
  } as IGitHubRepository;
}

const cacheFor = (project: Project) => versionCaches.get(project.id).cache;

describe('VersionService', () => {
  let metrics: FakeMetrics;
  let deferred: FakeDeferred;

  beforeEach(() => {
    metrics = new FakeMetrics();
    deferred = new FakeDeferred();
    versionCaches.clear();
  });

  const latest = (service: VersionService, project: Project, channel: string) =>
    service.getLatestRelease(deferred as unknown as DeferredRepository, project, channel);

  describe('getLatestRelease', () => {
    it('returns the tag, its version and its publish date', async () => {
      const service = new VersionService(createReleaseRepository(), metrics);

      expect(await latest(service, immich, 'stable')).toEqual({
        tag: 'v1.130.0',
        version: '1.130.0',
        published_at: '2025-04-01T00:00:00Z',
      });
    });

    it('fills every channel from one read', async () => {
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      expect(await latest(service, immich, 'stable')).toMatchObject({ tag: 'v1.130.0' });
      expect(await latest(service, immich, 'rc')).toMatchObject({ tag: 'v1.130.0' });

      expect(repository.list).toHaveBeenCalledOnce();
      expect(metrics.names()).toEqual(['memory_cache_miss', 'memory_cache_hit']);
    });

    it('caches an empty channel as null, so it is not read again', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease] });
      const service = new VersionService(repository, metrics);
      const rcOnly = createReleaseRepository({ immich: [stored('v1.131.0-rc.1')] });
      const rcService = new VersionService(rcOnly, metrics);

      expect(await latest(rcService, immich, 'stable')).toBeNull();
      expect(await latest(rcService, immich, 'stable')).toBeNull();
      expect(await latest(service, immich, 'rc')).toMatchObject({ tag: 'v1.131.0-rc.1' });

      expect(rcOnly.list).toHaveBeenCalledOnce();
      expect(repository.list).not.toHaveBeenCalled();
      expect(cacheFor(immich).get()?.value).toEqual(
        new Map([
          ['stable', null],
          ['rc', expect.objectContaining({ tag: 'v1.131.0-rc.1' })],
        ]),
      );
    });

    it('keeps a cache per project, so two projects with the same tags never mix', async () => {
      const repository = createReleaseRepository({
        immich: [stored('v1.0.0', '2025-01-01T00:00:00Z')],
        other: [stored('v1.0.0', '2025-06-01T00:00:00Z'), stored('v2.0.0-rc1', '2025-07-01T00:00:00Z')],
      });
      const service = new VersionService(repository, metrics);

      expect(await latest(service, immich, 'stable')).toMatchObject({ published_at: '2025-01-01T00:00:00Z' });
      expect(await latest(service, other, 'stable')).toMatchObject({ published_at: '2025-06-01T00:00:00Z' });
      expect(await latest(service, other, 'rc')).toMatchObject({ tag: 'v2.0.0-rc1' });
      expect(await latest(service, immich, 'rc')).toMatchObject({ tag: 'v1.0.0' });
      expect(repository.list.mock.calls).toEqual([['immich'], ['other']]);

      versionCaches.invalidate('other');
      expect(cacheFor(immich).get()).not.toBeNull();
      expect(cacheFor(other).get()).toBeNull();
    });

    it('serves a stale entry and refreshes it once in the background', async () => {
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);
      cacheFor(immich).set(new Map([['stable', { tag: 'v1.120.0', version: '1.120.0', published_at: '' }]]));
      Object.assign(cacheFor(immich), { expiresAt: 0 });

      expect(await latest(service, immich, 'stable')).toMatchObject({ tag: 'v1.120.0' });
      expect(await latest(service, immich, 'stable')).toMatchObject({ tag: 'v1.120.0' });
      expect(deferred.calls).toHaveLength(1);
      expect(versionCaches.get('immich').revalidating).toBe(true);

      await deferred.run();

      expect(versionCaches.get('immich').revalidating).toBe(false);
      expect(await latest(service, immich, 'stable')).toMatchObject({ tag: 'v1.130.0' });
      expect(repository.list).toHaveBeenCalledOnce();
    });
  });

  describe('handleReleasePublished', () => {
    it("stores the release under the project, with GitHub's id and prerelease flag", async () => {
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      await service.handleReleasePublished(immich, { ...release, tag_name: 'v1.131.0-rc.1', prerelease: true });

      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [
        { tag: 'v1.131.0-rc.1', published_at: '2025-04-01T00:00:00Z', source_id: '4', forge_prerelease: true },
      ]);
    });

    it("skips a tag the project's pattern rejects", async () => {
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      await service.handleReleasePublished(immich, { ...release, tag_name: 'v1.131.0-rc1' });

      expect(repository.upsertMany).not.toHaveBeenCalled();
    });

    it('emits the upserted, latest version and release count metrics', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease, stored('v1.120.0')] });
      const service = new VersionService(repository, metrics);

      await service.handleReleasePublished(immich, release);

      expect(metrics.names()).toEqual(['webhook_release_upserted', 'd1_release_count', 'latest_version']);
      expect(metrics.find('webhook_release_upserted')?.tags.get('tag')).toBe('v1.130.0');
      expect(metrics.countOf('d1_release_count')).toBe(2);
    });

    it("invalidates only the project's cache and never marks it fully synced", async () => {
      cacheFor(immich).set(new Map());
      cacheFor(other).set(new Map());
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      await service.handleReleasePublished(immich, release);

      expect(cacheFor(immich).get()).toBeNull();
      expect(cacheFor(other).get()).not.toBeNull();
      expect(repository.markFullSynced).not.toHaveBeenCalled();
    });
  });

  describe('syncFromGitHub', () => {
    it("writes nothing when GitHub's latest release is the newest stored one", async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository();
      const github = createGitHubRepository();
      const service = new VersionService(repository, metrics);

      const result = await service.syncFromGitHub(immich, github);

      expect(result).toEqual({ synced: 0, full: false });
      expect(github.fetchReleases).not.toHaveBeenCalled();
      expect(repository.upsertMany).not.toHaveBeenCalled();
      expect(repository.markFullSynced).not.toHaveBeenCalled();
      expect(cacheFor(immich).get()).not.toBeNull();
    });

    it('fetches everything for a project with nothing stored, and records the full sync', async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository({ immich: [], other: [storedRelease] });
      const github = createGitHubRepository({
        fetchReleases: vi.fn(() => Promise.resolve([release, { ...release, id: 3, tag_name: 'v1.120.0' }])),
      });
      const service = new VersionService(repository, metrics);

      const result = await service.syncFromGitHub(immich, github);

      expect(result).toEqual({ synced: 2, full: true });
      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [
        storedRelease,
        { ...storedRelease, tag: 'v1.120.0', source_id: '3' },
      ]);
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
      expect(metrics.countOf('cron_releases_synced')).toBe(2);
      expect(cacheFor(immich).get()).toBeNull();
    });

    it('fetches everything when only a webhook has stored the latest release', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease] });
      const github = createGitHubRepository();
      const service = new VersionService(repository, metrics);

      expect(await service.syncFromGitHub(immich, github)).toEqual({ synced: 1, full: true });
      expect(github.fetchReleases).toHaveBeenCalled();
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
    });

    it("fetches everything when GitHub's latest is newer than what is stored", async () => {
      const repository = createReleaseRepository({ immich: [stored('v1.120.0')] });
      const github = createGitHubRepository();
      const service = new VersionService(repository, metrics);

      expect(await service.syncFromGitHub(immich, github)).toEqual({ synced: 1, full: true });
      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [storedRelease]);
    });

    it('returns no sync when GitHub has no latest release', async () => {
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);
      const github = createGitHubRepository({ fetchLatestRelease: vi.fn(() => Promise.resolve(null)) });

      expect(await service.syncFromGitHub(immich, github)).toEqual({ synced: 0, full: false });
      expect(repository.list).not.toHaveBeenCalled();
    });
  });

  describe('fullSync', () => {
    it('writes nothing when nothing changed, but still records the full sync', async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      expect(await service.fullSync(immich, createGitHubRepository())).toBe(1);

      expect(repository.upsertMany).not.toHaveBeenCalled();
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
      expect(metrics.countOf('cron_full_sync')).toBe(1);
      expect(cacheFor(immich).get()).not.toBeNull();
    });

    it('writes a changed release and invalidates the cache', async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository();
      const github = createGitHubRepository({
        fetchReleases: vi.fn(() => Promise.resolve([{ ...release, published_at: '2025-04-02T00:00:00Z' }])),
      });
      const service = new VersionService(repository, metrics);

      await service.fullSync(immich, github);

      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [
        { ...storedRelease, published_at: '2025-04-02T00:00:00Z' },
      ]);
      expect(cacheFor(immich).get()).toBeNull();
    });

    it('does not record a full sync that failed', async () => {
      const repository = createReleaseRepository();
      const github = createGitHubRepository({ fetchReleases: vi.fn(() => Promise.reject(new Error('GitHub down'))) });
      const service = new VersionService(repository, metrics);

      await expect(service.fullSync(immich, github)).rejects.toThrow('GitHub down');
      expect(repository.markFullSynced).not.toHaveBeenCalled();
    });
  });

  describe('emitReleaseStats', () => {
    it("emits the release count and the default channel's version with the server user agent", async () => {
      const repository = createReleaseRepository({ immich: [storedRelease, stored('v1.131.0-rc.1')] });
      const service = new VersionService(repository, metrics);

      await service.emitReleaseStats(immich);

      expect(metrics.countOf('d1_release_count')).toBe(2);
      const metric = metrics.find('latest_version');
      expect(metric!.tags).toEqual(
        new Map([
          ['version', '1.130.0'],
          ['user_agent', 'immich-server/1.130.0'],
        ]),
      );
    });

    it('leaves out the user agent for a project without one', async () => {
      const service = new VersionService(createReleaseRepository({ other: [stored('v1.0.0')] }), metrics);

      await service.emitReleaseStats(other);

      expect(metrics.find('latest_version')!.tags).toEqual(new Map([['version', '1.0.0']]));
    });

    it('emits only the count when there is no latest release', async () => {
      const service = new VersionService(createReleaseRepository({ immich: [stored('v1.131.0-rc.1')] }), metrics);

      await service.emitReleaseStats(immich);

      expect(metrics.names()).toEqual(['d1_release_count']);
    });
  });
});

describe('changedReleases', () => {
  const current = [stored('v1.0.0', 'a', '1', false), stored('v1.1.0', 'b', '2', false)];

  it('keeps new releases and drops unchanged ones', () => {
    expect(changedReleases(immich, [...current, stored('v1.2.0', 'c', '3')], current)).toEqual([
      stored('v1.2.0', 'c', '3'),
    ]);
  });

  it.each<[string, ProjectRelease]>([
    ['published date', stored('v1.0.0', 'z', '1', false)],
    ['source id', stored('v1.0.0', 'a', '9', false)],
    ['forge prerelease flag', stored('v1.0.0', 'a', '1', true)],
    ['forge prerelease flag, now unknown', stored('v1.0.0', 'a', '1', null)],
  ])('keeps a release whose %s changed', (_, changed) => {
    expect(changedReleases(immich, [changed, current[1]], current)).toEqual([changed]);
  });

  it("drops tags the project's pattern rejects", () => {
    expect(changedReleases(immich, [stored('v1.13.0_20-dev'), stored('v1.2.0-rc1'), stored('v1.2.0')], [])).toEqual([
      stored('v1.2.0'),
    ]);
  });

  it('keeps the first of a release listed twice', () => {
    expect(changedReleases(immich, [stored('v1.2.0', 'first'), stored('v1.2.0', 'second')], [])).toEqual([
      stored('v1.2.0', 'first'),
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredRepository } from './deferred.js';
import { CloudflareMetricsRepository, type Metric } from './metrics.js';
import { legacyProject, loadProjects, type Project } from './projects.js';
import type { IReleaseRepository } from './release-repository.js';
import { MAX_RETRACTION_CHECKS, RateLimitError, type FetchedReleases, type ReleaseSource } from './sources.js';
import type { GitHubRelease, ProjectRelease } from './types.js';
import { changedReleases, versionCaches, VersionService } from './version-service.js';

// A real repository, as on a request through LHR, that keeps every metric
// pushed through it or any scope of it, so the tags are the ones that ship.
class RecordingMetrics extends CloudflareMetricsRepository {
  readonly pushed: Metric[];

  constructor() {
    const pushed: Metric[] = [];
    const recorder = {
      pushMetric: (metric: Metric) => {
        pushed.push(metric);
      },
      flush: () => {},
    };
    super('version', [recorder], { colo: 'LHR' });
    this.pushed = pushed;
  }

  names(): string[] {
    return this.pushed.map((metric) => metric.name.replace(/^version_/, ''));
  }

  find(name: string): Metric | undefined {
    return this.pushed.find((metric) => metric.name === `version_${name}`);
  }

  countOf(name: string): number | undefined {
    return this.find(name)?.fields.get('count')?.value;
  }

  tagsOf(name: string): Record<string, string> {
    const metric = this.find(name);
    expect(metric, `${name} was not emitted`).toBeDefined();
    return Object.fromEntries(metric!.tags);
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
    deleteMany: vi.fn(
      (projectId: string, releases: readonly Pick<ProjectRelease, 'tag' | 'source_id'>[], _writtenBefore: string) => {
        const before = data.get(projectId) ?? [];
        const after = before.filter((row) =>
          releases.every(({ tag, source_id }) => !(tag === row.tag && source_id === row.source_id)),
        );
        data.set(projectId, after);
        return Promise.resolve(before.length - after.length);
      },
    ),
    now: vi.fn(() => Promise.resolve(new Date().toISOString())),
    getFullSyncedAt: vi.fn((projectId: string) => Promise.resolve(syncedAt.get(projectId) ?? null)),
    markFullSynced: vi.fn((projectId: string) => {
      syncedAt.set(projectId, 'now');
      return Promise.resolve();
    }),
  } satisfies IReleaseRepository;
}

// A source that lists `releases`, newest first, in full and as its recent page,
// and confirms that every release it is asked about is gone.
function createSource(releases: ProjectRelease[] = [storedRelease], complete = true) {
  return {
    rateLimitKey: 'test',
    fetchRecent: vi.fn((_options?: { signal?: AbortSignal }) => Promise.resolve(releases.slice(0, 20))),
    fetchAll: vi.fn((_options?: { signal?: AbortSignal }) => Promise.resolve<FetchedReleases>({ releases, complete })),
    confirmRetracted: vi.fn((candidates: readonly ProjectRelease[], _options?: { signal?: AbortSignal }) =>
      Promise.resolve([...candidates]),
    ),
  } satisfies ReleaseSource;
}

const cacheFor = (project: Project) => versionCaches.get(project.id).cache;

describe('VersionService', () => {
  let metrics: RecordingMetrics;
  let deferred: FakeDeferred;

  beforeEach(() => {
    metrics = new RecordingMetrics();
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
      expect(metrics.names()).toEqual(['memory_cache_miss', 'd1_get_latest', 'memory_cache_hit']);
    });

    it("tags its metrics with the project and the request's colo", async () => {
      const service = new VersionService(createReleaseRepository({ other: [stored('v1.0.0')] }), metrics);

      await latest(service, other, 'stable');
      await latest(service, other, 'stable');
      cacheFor(other).set(new Map());
      Object.assign(cacheFor(other), { expiresAt: 0 });
      await latest(service, other, 'stable');

      expect(metrics.names()).toEqual(['memory_cache_miss', 'd1_get_latest', 'memory_cache_hit', 'memory_cache_stale']);
      for (const metric of metrics.pushed) {
        expect(Object.fromEntries(metric.tags), metric.name).toEqual({ version_project: 'other', colo: 'LHR' });
      }
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

      expect(metrics.names()).toEqual([
        'webhook_upsert',
        'webhook_release_upserted',
        'd1_release_count',
        'latest_version',
      ]);
      expect(metrics.find('webhook_release_upserted')?.tags.get('tag')).toBe('v1.130.0');
      expect(metrics.countOf('d1_release_count')).toBe(2);
    });

    it("writes the release stats to the crons' series, without the request's colo", async () => {
      const service = new VersionService(createReleaseRepository(), metrics);

      await service.handleReleasePublished(immich, release);

      expect(metrics.tagsOf('webhook_upsert')).toEqual({ version_project: 'immich', colo: 'LHR' });
      expect(metrics.tagsOf('webhook_release_upserted')).toEqual({
        version_project: 'immich',
        colo: 'LHR',
        tag: 'v1.130.0',
      });
      expect(metrics.tagsOf('d1_release_count')).toEqual({ version_project: 'immich' });
      expect(metrics.tagsOf('latest_version')).toEqual({
        version_project: 'immich',
        version: '1.130.0',
        user_agent: 'immich-server/1.130.0',
      });
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

  describe('syncProject', () => {
    it('lists only the newest releases of a fully synced project, and writes the new ones', async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository();
      const rc = stored('v1.131.0-rc.1', '2025-04-02T00:00:00Z', '5', true);
      const source = createSource([rc, storedRelease]);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, source);

      expect(result).toEqual({
        mode: 'incremental',
        releases: [storedRelease, rc],
        written: 1,
        deleted: 0,
        skipped: 0,
      });
      expect(source.fetchRecent).toHaveBeenCalledOnce();
      expect(source.fetchAll).not.toHaveBeenCalled();
      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [rc]);
      expect(repository.markFullSynced).not.toHaveBeenCalled();
      expect(cacheFor(immich).get()).toBeNull();
    });

    it('writes nothing and keeps the cache when nothing changed', async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      expect(await service.syncProject(immich, createSource())).toMatchObject({ mode: 'incremental', written: 0 });

      expect(repository.upsertMany).not.toHaveBeenCalled();
      expect(repository.deleteMany).not.toHaveBeenCalled();
      expect(cacheFor(immich).get()).not.toBeNull();
    });

    it('never deletes on an incremental sync, which only sees the newest releases', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease, stored('v1.120.0')] }, ['immich']);
      const source = createSource([storedRelease]);
      const service = new VersionService(repository, metrics);

      await service.syncProject(immich, source);

      expect(source.confirmRetracted).not.toHaveBeenCalled();
      expect(repository.deleteMany).not.toHaveBeenCalled();
    });

    it('fetches everything for a project with nothing stored, and records the full sync', async () => {
      cacheFor(immich).set(new Map());
      const repository = createReleaseRepository({ immich: [], other: [storedRelease] });
      const older = { ...storedRelease, tag: 'v1.120.0', source_id: '3' };
      const source = createSource([storedRelease, older]);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, source);

      expect(result).toMatchObject({ mode: 'full', written: 2, deleted: 0 });
      expect(source.fetchRecent).not.toHaveBeenCalled();
      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [storedRelease, older]);
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
      expect(cacheFor(immich).get()).toBeNull();
    });

    it('fetches everything while only a webhook has stored releases', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease] });
      const source = createSource();
      const service = new VersionService(repository, metrics);

      expect(await service.syncProject(immich, source)).toMatchObject({ mode: 'full' });
      expect(source.fetchAll).toHaveBeenCalledOnce();
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
    });

    it('fetches everything when asked, as the nightly run does, but writes only what changed', async () => {
      const repository = createReleaseRepository();
      const changed = { ...storedRelease, published_at: '2025-04-02T00:00:00Z' };
      const source = createSource([changed, stored('v1.120.0', '2025-03-01T00:00:00Z', '3')]);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, source, { full: true });

      expect(result).toMatchObject({ mode: 'full', written: 2 });
      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [
        changed,
        stored('v1.120.0', '2025-03-01T00:00:00Z', '3'),
      ]);
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
    });

    it('deletes the releases a complete listing no longer has, once the source confirms they are gone', async () => {
      cacheFor(immich).set(new Map());
      const retracted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
      const source = createSource([storedRelease]);
      const { signal } = new AbortController();
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, source, { full: true, signal });

      expect(result).toEqual({ mode: 'full', releases: [storedRelease], written: 0, deleted: 1, skipped: 0 });
      expect(source.confirmRetracted).toHaveBeenCalledWith([retracted], { signal });
      expect(repository.deleteMany).toHaveBeenCalledWith('immich', [retracted], expect.any(String));
      expect(cacheFor(immich).get()).toBeNull();
      expect(metrics.tagsOf('source_confirm_retracted')).toMatchObject({
        version_project: 'immich',
        source: 'github-releases',
      });
    });

    it('keeps the unlisted releases the source does not confirm are gone', async () => {
      cacheFor(immich).set(new Map());
      const deleted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      // Still published, but missed by a listing whose pages shifted.
      const missed = stored('v1.120.0', '2025-03-01T00:00:00Z', '3');
      const repository = createReleaseRepository({ immich: [storedRelease, deleted, missed] }, ['immich']);
      const source = createSource([storedRelease]);
      source.confirmRetracted.mockResolvedValueOnce([deleted]);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, source, { full: true });

      expect(source.confirmRetracted).toHaveBeenCalledWith([deleted, missed], expect.anything());
      expect(repository.deleteMany).toHaveBeenCalledWith('immich', [deleted], expect.any(String));
      expect(result).toMatchObject({ deleted: 1, releases: [storedRelease, missed] });
      expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
    });

    it('deletes nothing, and keeps the cache, when the source confirms none of them', async () => {
      cacheFor(immich).set(new Map());
      const missed = stored('v1.120.0', '2025-03-01T00:00:00Z', '3');
      const repository = createReleaseRepository({ immich: [storedRelease, missed] }, ['immich']);
      const source = createSource([storedRelease]);
      source.confirmRetracted.mockResolvedValueOnce([]);
      const service = new VersionService(repository, metrics);

      expect(await service.syncProject(immich, source, { full: true })).toMatchObject({ deleted: 0 });
      expect(repository.deleteMany).not.toHaveBeenCalled();
      expect(cacheFor(immich).get()).not.toBeNull();
    });

    it(`asks the source about at most ${MAX_RETRACTION_CHECKS} releases a sync, the newest first`, async () => {
      // Published a second apart, oldest first.
      const unlisted = Array.from({ length: MAX_RETRACTION_CHECKS + 5 }, (_, index) =>
        stored(`v1.${index}.0`, `2024-01-01T00:00:${String(index).padStart(2, '0')}Z`, String(100 + index)),
      );
      const repository = createReleaseRepository({ immich: [storedRelease, ...unlisted] }, ['immich']);
      const source = createSource([storedRelease]);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, source, { full: true });

      const newest = Array.from({ length: MAX_RETRACTION_CHECKS }, (_, index) => unlisted[unlisted.length - 1 - index]);
      expect(source.confirmRetracted).toHaveBeenCalledWith(newest, expect.anything());
      expect(repository.deleteMany).toHaveBeenCalledWith('immich', newest, expect.any(String));
      // The oldest wait for the next full sync.
      expect(result.releases).toEqual([storedRelease, ...unlisted.slice(0, 5)]);
    });

    it('deletes nothing, and records no full sync, when the source hits its rate limit while confirming', async () => {
      const repository = createReleaseRepository(
        { immich: [storedRelease, stored('v1.131.0', '2025-05-01T00:00:00Z', '6')] },
        ['immich'],
      );
      const source = createSource([storedRelease]);
      source.confirmRetracted.mockRejectedValueOnce(new RateLimitError('GitHub API rate limit exceeded'));
      const service = new VersionService(repository, metrics);

      await expect(service.syncProject(immich, source, { full: true })).rejects.toBeInstanceOf(RateLimitError);
      expect(repository.deleteMany).not.toHaveBeenCalled();
      expect(repository.markFullSynced).not.toHaveBeenCalled();
    });

    it('deletes nothing when the listing stopped at its cap, even a release published after the oldest listed', async () => {
      const pastCap = stored('v1.0.0', '2020-01-01T00:00:00Z');
      // Created before everything listed, so past the cap of GitHub's creation-date order, but published lately.
      const publishedLately = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      const repository = createReleaseRepository({ immich: [storedRelease, pastCap, publishedLately] }, ['immich']);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, createSource([storedRelease], false), { full: true });

      expect(result).toMatchObject({ mode: 'full', deleted: 0 });
      expect(repository.deleteMany).not.toHaveBeenCalled();
      expect(result.releases).toContainEqual(publishedLately);
    });

    it('takes down the last release a complete empty listing lacks, once the source confirms it is gone', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease] }, ['immich']);
      const service = new VersionService(repository, metrics);

      expect(await service.syncProject(immich, createSource([]), { full: true })).toMatchObject({
        deleted: 1,
        releases: [],
      });
      expect(repository.deleteMany).toHaveBeenCalledWith('immich', [storedRelease], expect.any(String));
    });

    it('keeps everything when a complete empty listing is not confirmed', async () => {
      const repository = createReleaseRepository({ immich: [storedRelease] }, ['immich']);
      const source = createSource([]);
      source.confirmRetracted.mockResolvedValueOnce([]);
      const service = new VersionService(repository, metrics);

      expect(await service.syncProject(immich, source, { full: true })).toMatchObject({ deleted: 0 });
      expect(repository.deleteMany).not.toHaveBeenCalled();
      expect(await repository.list('immich')).toEqual([storedRelease]);
    });

    it('counts the rows the delete removed, not the releases confirmed gone', async () => {
      const retracted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
      // Written again while the checks ran, so the delete leaves it.
      repository.deleteMany.mockResolvedValueOnce(0);
      const service = new VersionService(repository, metrics);

      const result = await service.syncProject(immich, createSource([storedRelease]), { full: true });

      expect(result.deleted).toBe(0);
      expect(metrics.countOf('releases_deleted')).toBe(0);
    });

    it('deletes only rows written before its checks began', async () => {
      const retracted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
      const source = createSource([storedRelease]);
      let checkedAt = '';
      source.confirmRetracted.mockImplementationOnce((candidates) => {
        checkedAt = new Date().toISOString();
        return Promise.resolve([...candidates]);
      });
      const service = new VersionService(repository, metrics);

      await service.syncProject(immich, source, { full: true });

      const writtenBefore = repository.deleteMany.mock.calls[0][2];
      expect(writtenBefore <= checkedAt).toBe(true);
    });

    it('keeps a release a webhook stored under a retracted tag while the checks ran', async () => {
      const retracted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      const replacement = stored('v1.131.0', '2025-05-02T00:00:00Z', '7');
      const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
      const source = createSource([storedRelease]);
      source.confirmRetracted.mockImplementationOnce(async (candidates) => {
        // The webhook lands mid-check: the same tag, published again as a new release.
        await repository.upsertMany('immich', [replacement]);
        return [...candidates];
      });
      const service = new VersionService(repository, metrics);

      await service.syncProject(immich, source, { full: true });

      expect(repository.deleteMany).toHaveBeenCalledWith('immich', [retracted], expect.any(String));
      expect(await repository.list('immich')).toContainEqual(replacement);
    });

    it('invalidates the cache once the upsert lands, even if the delete after it fails', async () => {
      cacheFor(immich).set(new Map());
      const retracted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
      repository.deleteMany.mockRejectedValue(new Error('D1_ERROR: delete failed'));
      const changed = { ...storedRelease, published_at: '2025-04-02T00:00:00Z' };
      const service = new VersionService(repository, metrics);

      await expect(service.syncProject(immich, createSource([changed]), { full: true })).rejects.toThrow(
        'delete failed',
      );

      expect(repository.upsertMany).toHaveBeenCalledWith('immich', [changed]);
      expect(cacheFor(immich).get()).toBeNull();
      expect(repository.markFullSynced).not.toHaveBeenCalled();
    });

    it('records nothing when the fetch fails', async () => {
      const repository = createReleaseRepository({ immich: [] });
      const source = createSource();
      source.fetchAll.mockRejectedValue(new Error('GitHub down'));
      const service = new VersionService(repository, metrics);

      await expect(service.syncProject(immich, source)).rejects.toThrow('GitHub down');
      expect(repository.upsertMany).not.toHaveBeenCalled();
      expect(repository.markFullSynced).not.toHaveBeenCalled();
    });

    it("passes the caller's signal to the source", async () => {
      const source = createSource();
      const { signal } = new AbortController();
      const service = new VersionService(createReleaseRepository(), metrics);

      await service.syncProject(immich, source, { signal });
      await service.syncProject(immich, source, { full: true, signal });

      expect(source.fetchRecent).toHaveBeenCalledWith({ signal });
      expect(source.fetchAll).toHaveBeenCalledWith({ signal });
    });

    describe('past its deadline', () => {
      const changed = { ...storedRelease, published_at: '2025-04-02T00:00:00Z' };
      const retracted = stored('v1.131.0', '2025-05-01T00:00:00Z', '6');
      let controller: AbortController;

      // A call still running when the deadline passes: it aborts the signal, then settles as `result`.
      const deadlinePassesDuring =
        <T>(result: T) =>
        () => {
          controller.abort(new DOMException('deadline', 'TimeoutError'));
          return Promise.resolve(result);
        };

      const sync = (repository: IReleaseRepository, source: ReleaseSource) =>
        new VersionService(repository, metrics).syncProject(immich, source, { full: true, signal: controller.signal });

      beforeEach(() => {
        controller = new AbortController();
      });

      it('fetches nothing once it passes during a read', async () => {
        const repository = createReleaseRepository();
        repository.list.mockImplementationOnce(deadlinePassesDuring([storedRelease]));
        const source = createSource([changed]);

        await expect(sync(repository, source)).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(source.fetchAll).not.toHaveBeenCalled();
      });

      it('writes nothing once it passes during the fetch', async () => {
        const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
        const source = createSource();
        source.fetchAll.mockImplementationOnce(deadlinePassesDuring({ releases: [changed], complete: true }));

        await expect(sync(repository, source)).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(repository.upsertMany).not.toHaveBeenCalled();
        expect(repository.deleteMany).not.toHaveBeenCalled();
        expect(repository.markFullSynced).not.toHaveBeenCalled();
      });

      it.each([
        ['a delete to follow', [storedRelease, retracted]],
        ['only the full sync left to record', [storedRelease]],
      ])('starts no write after an upsert that lands past it, with %s, but drops the cache', async (_, rows) => {
        cacheFor(immich).set(new Map());
        const repository = createReleaseRepository({ immich: rows }, ['immich']);
        repository.upsertMany.mockImplementationOnce(deadlinePassesDuring(undefined));
        const source = createSource([changed]);

        await expect(sync(repository, source)).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(repository.upsertMany).toHaveBeenCalledWith('immich', [changed]);
        expect(source.confirmRetracted).not.toHaveBeenCalled();
        expect(repository.deleteMany).not.toHaveBeenCalled();
        expect(repository.markFullSynced).not.toHaveBeenCalled();
        expect(cacheFor(immich).get()).toBeNull();
      });

      it('deletes nothing once it passes while the source confirms', async () => {
        cacheFor(immich).set(new Map());
        const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
        const source = createSource([storedRelease]);
        source.confirmRetracted.mockImplementationOnce(deadlinePassesDuring([retracted]));

        await expect(sync(repository, source)).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(source.confirmRetracted).toHaveBeenCalledOnce();
        expect(repository.deleteMany).not.toHaveBeenCalled();
        expect(repository.markFullSynced).not.toHaveBeenCalled();
        expect(cacheFor(immich).get()).not.toBeNull();
      });

      it('records no full sync after a delete that lands past it, but drops the cache', async () => {
        cacheFor(immich).set(new Map());
        const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
        repository.deleteMany.mockImplementationOnce(deadlinePassesDuring(1));

        await expect(sync(repository, createSource([storedRelease]))).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(repository.upsertMany).not.toHaveBeenCalled();
        expect(repository.deleteMany).toHaveBeenCalledWith('immich', [retracted], expect.any(String));
        expect(repository.markFullSynced).not.toHaveBeenCalled();
        expect(cacheFor(immich).get()).toBeNull();
      });

      it('reports nothing once it passes while the full sync is recorded', async () => {
        const repository = createReleaseRepository();
        repository.markFullSynced.mockImplementationOnce(deadlinePassesDuring(undefined));

        await expect(sync(repository, createSource())).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(repository.markFullSynced).toHaveBeenCalledWith('immich');
        expect(metrics.names()).not.toContain('releases_written');
      });
    });

    it('counts the newest releases no project on the source recognizes', async () => {
      const service = new VersionService(createReleaseRepository(), metrics);
      const source = createSource([
        stored('v2.0.0-beta.1', '2025-06-01T00:00:00Z'),
        stored('nightly', '2025-05-01T00:00:00Z'),
        storedRelease,
        stored('v1.13.0_20-dev', '2023-01-01T00:00:00Z'),
      ]);

      expect(await service.syncProject(immich, source)).toMatchObject({ skipped: 2 });
      expect(metrics.countOf('tags_skipped')).toBe(2);
    });

    it('counts them from the newest release still stored, not one the sync took down', async () => {
      const retracted = stored('v1.131.0', '2025-06-01T00:00:00Z', '6');
      const repository = createReleaseRepository({ immich: [storedRelease, retracted] }, ['immich']);
      const service = new VersionService(repository, metrics);
      const source = createSource([stored('nightly', '2025-05-01T00:00:00Z'), storedRelease]);

      const result = await service.syncProject(immich, source, { full: true });

      expect(result).toEqual({ mode: 'full', releases: [storedRelease], written: 0, deleted: 1, skipped: 1 });
      expect(metrics.countOf('tags_skipped')).toBe(1);
      // The releases it ended with are read once, after the delete.
      expect(repository.list).toHaveBeenCalledTimes(2);
    });

    it("tags the sync's metrics with the project, and its fetches with the source type", async () => {
      const repository = createReleaseRepository({ other: [] });
      const service = new VersionService(repository, metrics);

      await service.syncProject(other, createSource([stored('v1.0.0')]));

      expect(metrics.names()).toEqual([
        'source_fetch_all',
        'd1_bulk_upsert',
        'releases_written',
        'releases_deleted',
        'tags_skipped',
      ]);
      for (const name of metrics.names()) {
        expect(metrics.tagsOf(name)).toMatchObject({ version_project: 'other' });
      }
      expect(metrics.tagsOf('source_fetch_all')).toMatchObject({ source: 'github-releases' });
      expect(metrics.tagsOf('releases_written')).toMatchObject({ mode: 'full' });
      expect(metrics.countOf('releases_written')).toBe(1);
    });
  });

  describe('emitReleaseStats', () => {
    it("emits the release count and the default channel's version with the server user agent", async () => {
      const repository = createReleaseRepository({ immich: [storedRelease, stored('v1.131.0-rc.1')] });
      const service = new VersionService(repository, metrics);

      await service.emitReleaseStats(immich);

      expect(metrics.countOf('d1_release_count')).toBe(2);
      expect(metrics.tagsOf('latest_version')).toEqual({
        version_project: 'immich',
        version: '1.130.0',
        user_agent: 'immich-server/1.130.0',
      });
    });

    it('leaves out the user agent for a project without one', async () => {
      const service = new VersionService(createReleaseRepository({ other: [stored('v1.0.0')] }), metrics);

      await service.emitReleaseStats(other);

      expect(metrics.tagsOf('d1_release_count')).toEqual({ version_project: 'other' });
      expect(metrics.tagsOf('latest_version')).toEqual({ version_project: 'other', version: '1.0.0' });
    });

    it('uses the releases a sync passes instead of reading them again', async () => {
      const repository = createReleaseRepository();
      const service = new VersionService(repository, metrics);

      await service.emitReleaseStats(immich, [storedRelease, stored('v1.131.0')]);

      expect(repository.list).not.toHaveBeenCalled();
      expect(metrics.countOf('d1_release_count')).toBe(2);
      expect(metrics.tagsOf('latest_version')).toMatchObject({ version: '1.131.0' });
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

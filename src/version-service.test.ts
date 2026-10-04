import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGitHubRepository } from './github-repository.js';
import { type IMetricsRepository, Metric } from './metrics.js';
import type { AsyncFn, Operation } from './monitor.js';
import type { IReleaseRepository, ReleaseChannel } from './release-repository.js';
import type { GitHubRelease, VersionResponse } from './types.js';
import { VersionService, versionCache } from './version-service.js';

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

const release: GitHubRelease = {
  id: 4,
  tag_name: 'v1.130.0',
  name: 'v1.130.0',
  url: 'https://api.github.com/repos/immich-app/immich/releases/4',
  body: 'New release',
  created_at: '2025-04-01T00:00:00Z',
  published_at: '2025-04-01T00:00:00Z',
};

const cachedVersions = (): Map<ReleaseChannel, VersionResponse> =>
  new Map([['stable', { version: 'v1.120.0', published_at: '2025-03-01T00:00:00Z' }]]);

function createReleaseRepository(overrides: Partial<IReleaseRepository> = {}): IReleaseRepository {
  return {
    getLatest: vi.fn(() => Promise.resolve<GitHubRelease | null>(release)),
    getNewerThan: vi.fn(() => Promise.resolve([])),
    getLatestPatchPerMinor: vi.fn(() => Promise.resolve([])),
    getCount: vi.fn(() => Promise.resolve(42)),
    upsert: vi.fn(() => Promise.resolve()),
    bulkUpsert: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function createGitHubRepository(overrides: Partial<IGitHubRepository> = {}): IGitHubRepository {
  return {
    fetchLatestRelease: vi.fn(() => Promise.resolve<GitHubRelease | null>(release)),
    fetchReleases: vi.fn(() => Promise.resolve([release])),
    ...overrides,
  } as IGitHubRepository;
}

describe('VersionService', () => {
  let metrics: FakeMetrics;

  beforeEach(() => {
    metrics = new FakeMetrics();
    versionCache.invalidate();
  });

  describe('handleReleasePublished', () => {
    it('upserts the release', async () => {
      const releaseRepository = createReleaseRepository();
      const service = new VersionService(releaseRepository, metrics);

      await service.handleReleasePublished(release);

      expect(releaseRepository.upsert).toHaveBeenCalledWith(release);
    });

    it('emits the d1_release_count metric from the repository count', async () => {
      const releaseRepository = createReleaseRepository({ getCount: vi.fn(() => Promise.resolve(7)) });
      const service = new VersionService(releaseRepository, metrics);

      await service.handleReleasePublished(release);

      expect(releaseRepository.getCount).toHaveBeenCalledOnce();
      expect(metrics.names()).toContain('d1_release_count');
      expect(metrics.countOf('d1_release_count')).toBe(7);
    });

    it('emits the upserted, latest version, and release count metrics', async () => {
      const releaseRepository = createReleaseRepository();
      const service = new VersionService(releaseRepository, metrics);

      await service.handleReleasePublished(release);

      expect(metrics.names()).toEqual(
        expect.arrayContaining(['webhook_release_upserted', 'latest_version', 'd1_release_count']),
      );
    });

    it('invalidates the version cache', async () => {
      versionCache.set(cachedVersions());
      const service = new VersionService(createReleaseRepository(), metrics);

      await service.handleReleasePublished(release);

      expect(versionCache.get()).toBeNull();
    });
  });

  describe('syncFromGitHub', () => {
    it('emits the release count when nothing changed', async () => {
      const releaseRepository = createReleaseRepository({ getLatest: vi.fn(() => Promise.resolve(release)) });
      const service = new VersionService(releaseRepository, metrics);

      const result = await service.syncFromGitHub(createGitHubRepository());

      expect(result).toEqual({ synced: 0, full: false });
      expect(metrics.countOf('d1_release_count')).toBe(42);
    });

    it('emits the release count after a full sync of a new release', async () => {
      const releaseRepository = createReleaseRepository({ getLatest: vi.fn(() => Promise.resolve(null)) });
      const service = new VersionService(releaseRepository, metrics);

      const result = await service.syncFromGitHub(createGitHubRepository());

      expect(result).toEqual({ synced: 1, full: true });
      expect(metrics.countOf('d1_release_count')).toBe(42);
    });

    it('upserts only the latest release when its body changed', async () => {
      const releaseRepository = createReleaseRepository({
        getLatest: vi.fn(() => Promise.resolve({ ...release, body: 'Old notes' })),
      });
      const github = createGitHubRepository();
      const service = new VersionService(releaseRepository, metrics);

      const result = await service.syncFromGitHub(github);

      expect(result).toEqual({ synced: 1, full: false });
      expect(releaseRepository.upsert).toHaveBeenCalledExactlyOnceWith(release);
      expect(releaseRepository.bulkUpsert).not.toHaveBeenCalled();
      expect(github.fetchReleases).not.toHaveBeenCalled();
      expect(metrics.names()).toContain('cron_release_updated');
    });

    it('invalidates the version cache when the latest release body changed', async () => {
      versionCache.set(cachedVersions());
      const releaseRepository = createReleaseRepository({
        getLatest: vi.fn(() => Promise.resolve({ ...release, body: 'Old notes' })),
      });
      const service = new VersionService(releaseRepository, metrics);

      await service.syncFromGitHub(createGitHubRepository());

      expect(versionCache.get()).toBeNull();
    });

    it('invalidates the version cache after syncing a new release', async () => {
      versionCache.set(cachedVersions());
      const releaseRepository = createReleaseRepository({ getLatest: vi.fn(() => Promise.resolve(null)) });
      const service = new VersionService(releaseRepository, metrics);

      await service.syncFromGitHub(createGitHubRepository());

      expect(versionCache.get()).toBeNull();
    });

    it('keeps the version cache when nothing changed', async () => {
      versionCache.set(cachedVersions());
      const service = new VersionService(createReleaseRepository(), metrics);

      await service.syncFromGitHub(createGitHubRepository());

      expect(versionCache.get()?.value).toEqual(cachedVersions());
    });

    it('returns no sync when GitHub has no latest release', async () => {
      const service = new VersionService(createReleaseRepository(), metrics);
      const github = createGitHubRepository({ fetchLatestRelease: vi.fn(() => Promise.resolve(null)) });

      const result = await service.syncFromGitHub(github);

      expect(result).toEqual({ synced: 0, full: false });
      expect(metrics.names()).not.toContain('d1_release_count');
    });
  });

  describe('fullSync', () => {
    it('emits the release count after bulk upserting', async () => {
      const releaseRepository = createReleaseRepository();
      const service = new VersionService(releaseRepository, metrics);

      const count = await service.fullSync(createGitHubRepository());

      expect(count).toBe(1);
      expect(releaseRepository.bulkUpsert).toHaveBeenCalledWith([release]);
      expect(metrics.countOf('d1_release_count')).toBe(42);
    });

    it('invalidates the version cache', async () => {
      versionCache.set(cachedVersions());
      const service = new VersionService(createReleaseRepository(), metrics);

      await service.fullSync(createGitHubRepository());

      expect(versionCache.get()).toBeNull();
    });
  });

  describe('emitLatestVersion', () => {
    it('strips the leading v and emits the latest_version metric', async () => {
      const service = new VersionService(createReleaseRepository(), metrics);

      await service.emitLatestVersion();

      const metric = metrics.find('latest_version');
      expect(metric).toBeDefined();
      expect(metric!.tags.get('version')).toBe('1.130.0');
      expect(metric!.tags.get('user_agent')).toBe('immich-server/1.130.0');
    });

    it('does not emit when there is no latest release', async () => {
      const service = new VersionService(
        createReleaseRepository({ getLatest: vi.fn(() => Promise.resolve(null)) }),
        metrics,
      );

      await service.emitLatestVersion();

      expect(metrics.names()).not.toContain('latest_version');
    });
  });
});

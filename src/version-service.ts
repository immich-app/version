import type { DeferredRepository } from './deferred.js';
import { toProjectRelease, type IGitHubRepository } from './github-repository.js';
import { MemoryCache } from './memory-cache.js';
import { Metric, projectMetrics, type IMetricsRepository } from './metrics.js';
import { normalize, type Project } from './projects.js';
import type { IReleaseRepository } from './release-repository.js';
import { latestPerChannel } from './releases.js';
import type { GitHubRelease, LatestRelease, ProjectRelease } from './types.js';

const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// The newest release on each of a project's channels, null for an empty one.
type ChannelReleases = Map<string, LatestRelease | null>;

interface ProjectVersionCache {
  cache: MemoryCache<ChannelReleases>;
  // Set while a background refresh runs, so concurrent stale requests start one.
  revalidating: boolean;
}

/**
 * One version cache per project, made on first use. Only registered projects
 * reach it, so it stays bounded. Every channel is cached, empty ones as null,
 * so a project without an rc still answers rc requests from memory.
 */
export class VersionCaches {
  private entries = new Map<string, ProjectVersionCache>();

  get(projectId: string): ProjectVersionCache {
    let entry = this.entries.get(projectId);
    if (!entry) {
      entry = { cache: new MemoryCache<ChannelReleases>(VERSION_CACHE_TTL_MS), revalidating: false };
      this.entries.set(projectId, entry);
    }
    return entry;
  }

  invalidate(projectId: string): void {
    this.entries.get(projectId)?.cache.invalidate();
  }

  clear(): void {
    this.entries.clear();
  }
}

// Module-level state - persists across requests within the same isolate
export const versionCaches = new VersionCaches();

export class VersionService {
  constructor(
    private releaseRepository: IReleaseRepository,
    private metrics: IMetricsRepository,
  ) {}

  async getLatestRelease(
    deferred: DeferredRepository,
    project: Project,
    channel: string,
  ): Promise<LatestRelease | null> {
    const metrics = projectMetrics(this.metrics, project.id);
    const entry = versionCaches.get(project.id);
    const cached = entry.cache.get();

    if (cached && !cached.stale) {
      metrics.push(Metric.create('memory_cache_hit').intField('count', 1));
      return cached.value.get(channel) ?? null;
    }

    if (cached?.stale) {
      metrics.push(Metric.create('memory_cache_stale').intField('count', 1));
      if (!entry.revalidating) {
        entry.revalidating = true;
        deferred.defer(async () => {
          try {
            await this.refreshVersionCache(project);
          } finally {
            entry.revalidating = false;
          }
        });
      }
      return cached.value.get(channel) ?? null;
    }

    metrics.push(Metric.create('memory_cache_miss').intField('count', 1));
    const latest = await this.refreshVersionCache(project);
    return latest.get(channel) ?? null;
  }

  // One read of every stored release fills every channel. It reads all of the
  // project's rows, which d1_get_latest's duration keeps an eye on.
  private async refreshVersionCache(project: Project): Promise<ChannelReleases> {
    const releases = await projectMetrics(this.metrics, project.id).monitorAsyncFunction(
      { name: 'd1_get_latest' },
      () => this.releaseRepository.list(project.id),
    )();

    const latest = latestPerChannel(project, releases);
    versionCaches.get(project.id).cache.set(latest);
    return latest;
  }

  /**
   * Stores a release the webhook reported, if its tag is one of the project's.
   * It never marks the project as fully synced: one release says nothing about
   * the ones before it.
   */
  async handleReleasePublished(project: Project, release: GitHubRelease): Promise<void> {
    const metrics = projectMetrics(this.metrics, project.id);
    await metrics.monitorAsyncFunction({ name: 'webhook_upsert' }, async () => {
      if (normalize(project, release.tag_name)) {
        await this.releaseRepository.upsertMany(project.id, [toProjectRelease(release)]);
      }
    })();
    metrics.push(Metric.create('webhook_release_upserted').addTag('tag', release.tag_name).intField('count', 1));
    versionCaches.invalidate(project.id);
    await this.emitReleaseStats(project);
  }

  /**
   * Fetches every release when GitHub's latest isn't the newest stored one on
   * the project's default channel, or when the project has never had a full
   * sync. A webhook can store the latest release first, which must not stand in
   * for the history before it.
   */
  async syncFromGitHub(
    project: Project,
    githubRepository: IGitHubRepository,
  ): Promise<{ synced: number; full: boolean }> {
    const metrics = projectMetrics(this.metrics, project.id);
    const latest = await metrics.monitorAsyncFunction({ name: 'github_fetch_latest' }, () =>
      githubRepository.fetchLatestRelease(),
    )();

    if (!latest) {
      return { synced: 0, full: false };
    }

    const stored = await this.releaseRepository.list(project.id);
    const fullySynced = (await this.releaseRepository.getFullSyncedAt(project.id)) !== null;
    if (fullySynced && latestPerChannel(project, stored).get(project.defaultChannel)?.tag === latest.tag_name) {
      return { synced: 0, full: false };
    }

    const synced = await this.storeAllReleases(project, githubRepository, stored);
    metrics.push(Metric.create('cron_releases_synced').intField('count', synced));
    return { synced, full: true };
  }

  async fullSync(project: Project, githubRepository: IGitHubRepository): Promise<number> {
    const stored = await this.releaseRepository.list(project.id);
    const count = await this.storeAllReleases(project, githubRepository, stored);
    projectMetrics(this.metrics, project.id).push(Metric.create('cron_full_sync').intField('count', count));
    return count;
  }

  // Fetches every release, writes the ones that changed and records the full
  // sync. Returns how many releases were fetched.
  private async storeAllReleases(
    project: Project,
    githubRepository: IGitHubRepository,
    stored: ProjectRelease[],
  ): Promise<number> {
    const metrics = projectMetrics(this.metrics, project.id);
    const releases = await metrics.monitorAsyncFunction({ name: 'github_fetch_all' }, () =>
      githubRepository.fetchReleases(),
    )();

    const fetched = releases.map((release) => toProjectRelease(release));
    const changed = changedReleases(project, fetched, stored);
    if (changed.length > 0) {
      await metrics.monitorAsyncFunction({ name: 'd1_bulk_upsert' }, () =>
        this.releaseRepository.upsertMany(project.id, changed),
      )();
      versionCaches.invalidate(project.id);
    }

    await this.releaseRepository.markFullSynced(project.id);
    return releases.length;
  }

  // How many releases the project has stored, and the newest version on its
  // default channel. The user agent its servers would send at that version lets
  // the recording rules count the servers that are up to date. Both are about
  // the project, not a request, so the webhook writes the crons' series: none
  // of the request's geo tags, or "Releases Stored" would count a project
  // once per series.
  async emitReleaseStats(project: Project): Promise<void> {
    const metrics = projectMetrics(this.metrics, project.id, { geo: false });
    const releases = await this.releaseRepository.list(project.id);
    metrics.push(Metric.create('d1_release_count').intField('count', releases.length));

    const latest = latestPerChannel(project, releases).get(project.defaultChannel);
    if (!latest) {
      return;
    }

    const metric = Metric.create('latest_version').addTag('version', latest.version);
    const { serverUserAgentPrefix } = project.analytics;
    if (serverUserAgentPrefix) {
      metric.addTag('user_agent', `${serverUserAgentPrefix}${latest.version}`);
    }
    metrics.push(metric.intField('count', 1));
  }
}

/**
 * The fetched releases worth writing: the project's own tags (see normalize())
 * that are new, or whose published date, source id or forge prerelease flag
 * changed. At steady state that is none. A release listed twice, as when one is
 * published mid-fetch and shifts the pages, is written once.
 */
export function changedReleases(
  project: Project,
  fetched: readonly ProjectRelease[],
  stored: readonly ProjectRelease[],
): ProjectRelease[] {
  const storedByTag = new Map(stored.map((release) => [release.tag, release]));
  const seen = new Set<string>();

  return fetched.filter((release) => {
    if (seen.has(release.tag) || !normalize(project, release.tag)) {
      return false;
    }
    seen.add(release.tag);

    const existing = storedByTag.get(release.tag);
    return (
      !existing ||
      existing.published_at !== release.published_at ||
      existing.source_id !== release.source_id ||
      existing.forge_prerelease !== release.forge_prerelease
    );
  });
}

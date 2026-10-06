import type { DeferredRepository } from './deferred.js';
import { toProjectRelease } from './github-source.js';
import { MemoryCache } from './memory-cache.js';
import { Metric, projectMetrics, type IMetricsRepository } from './metrics.js';
import { normalize, type Project } from './projects.js';
import type { IReleaseRepository } from './release-repository.js';
import { latestPerChannel, retractedReleases, skippedTags } from './releases.js';
import { MAX_RETRACTION_CHECKS, type FetchedReleases, type ReleaseSource } from './sources.js';
import type { GitHubRelease, LatestRelease, ProjectRelease } from './types.js';

const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type SyncMode = 'full' | 'incremental';

export interface SyncOptions {
  // List every release, as the nightly run does.
  full?: boolean;
  // The project's sync deadline: it aborts the source's requests, and no write
  // starts after it.
  signal?: AbortSignal;
  // The registered projects on the project's source, itself included (sameSource()).
  sameSource?: readonly Project[];
}

export interface SyncResult {
  mode: SyncMode;
  // The project's stored releases after the sync.
  releases: ProjectRelease[];
  written: number;
  deleted: number;
  // See skippedTags().
  skipped: number;
}

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
   * Brings the project's stored releases in line with its source. A full sync
   * lists every release (up to the source's cap), writes what changed, deletes
   * what the source took down if the listing reached its end and the source
   * confirms it (retractedReleases(), confirmRetracted()), and records the full
   * sync. An incremental one lists the newest 20 and only writes. A project
   * gets full syncs until one succeeds, so a webhook that stored the latest
   * release first can't stand in for the history before it.
   *
   * Past the signal's deadline the caller has stopped waiting (withDeadline()).
   * A D1 call can't be aborted, so one already running may still land, but
   * nothing new starts: no write, no record of the full sync.
   */
  async syncProject(project: Project, source: ReleaseSource, options: SyncOptions = {}): Promise<SyncResult> {
    const { full = false, signal, sameSource = [project] } = options;
    const metrics = projectMetrics(this.metrics, project.id);
    const stored = await this.releaseRepository.list(project.id);
    const mode: SyncMode =
      full || (await this.releaseRepository.getFullSyncedAt(project.id)) === null ? 'full' : 'incremental';
    signal?.throwIfAborted();

    const tags = { source: project.source.type };
    let fetched: FetchedReleases;
    if (mode === 'full') {
      fetched = await metrics.monitorAsyncFunction({ name: 'source_fetch_all', tags }, () =>
        source.fetchAll({ signal }),
      )();
    } else {
      const recent = await metrics.monitorAsyncFunction({ name: 'source_fetch_recent', tags }, () =>
        source.fetchRecent({ signal }),
      )();
      fetched = { releases: recent, complete: false };
    }
    signal?.throwIfAborted();

    const changed = changedReleases(project, fetched.releases, stored);
    // Only a full listing shows what the source may no longer have. The source
    // is asked about each, up to MAX_RETRACTION_CHECKS a sync; the rest wait.
    const unlisted = mode === 'full' ? retractedReleases(fetched, stored).slice(0, MAX_RETRACTION_CHECKS) : [];
    // The cache is dropped after each write that lands, even past the deadline,
    // so a later one that fails or never starts can't leave it serving what the
    // first one changed.
    if (changed.length > 0) {
      await metrics.monitorAsyncFunction({ name: 'd1_bulk_upsert' }, () =>
        this.releaseRepository.upsertMany(project.id, changed),
      )();
      versionCaches.invalidate(project.id);
    }
    // After the upsert, so checks that run long can't hold up new releases.
    let retracted: ProjectRelease[] = [];
    let deleted = 0;
    // Rows written from here on (a webhook storing a release while the checks
    // run, even under a candidate's own id) are newer than what was checked.
    // D1's clock, which stamps every write when it lands.
    let checksStartedAt = '';
    if (unlisted.length > 0) {
      signal?.throwIfAborted();
      checksStartedAt = await this.releaseRepository.now();
      retracted = await metrics.monitorAsyncFunction({ name: 'source_confirm_retracted', tags }, () =>
        source.confirmRetracted(unlisted, { signal }),
      )();
    }
    if (retracted.length > 0) {
      signal?.throwIfAborted();
      deleted = await metrics.monitorAsyncFunction({ name: 'd1_bulk_delete' }, () =>
        // By tag and source id, and only rows not written since the checks began:
        // a webhook may have stored a release under one of these tags, or
        // republished one of these ids, while they ran.
        this.releaseRepository.deleteMany(project.id, retracted, checksStartedAt),
      )();
      versionCaches.invalidate(project.id);
    }
    if (mode === 'full') {
      signal?.throwIfAborted();
      await this.releaseRepository.markFullSynced(project.id);
    }

    // What is stored now, so skippedTags() can't measure from a release just
    // taken down. Read again only after a write: an upsert can also drop a
    // retagged release's old row (ReleaseRepository.upsertMany()).
    const releases =
      changed.length > 0 || retracted.length > 0 ? await this.releaseRepository.list(project.id) : stored;
    signal?.throwIfAborted();

    const skipped = skippedTags(project, sameSource, fetched.releases, releases);
    metrics.push(Metric.create('releases_written').addTag('mode', mode).intField('count', changed.length));
    // What the delete removed, not what was confirmed: a row written again during
    // the checks stays, as may a retagged release's old row the upsert dropped.
    metrics.push(Metric.create('releases_deleted').intField('count', deleted));
    metrics.push(Metric.create('tags_skipped').intField('count', skipped));

    return { mode, releases, written: changed.length, deleted, skipped };
  }

  // How many releases the project has stored, and the newest version on its
  // default channel. The user agent its servers would send at that version lets
  // the recording rules count the servers that are up to date. Both are about
  // the project, not a request, so the webhook writes the crons' series: none
  // of the request's geo tags, or "Releases Stored" would count a project
  // once per series. A sync passes the releases it ended with, so they aren't
  // read again.
  async emitReleaseStats(project: Project, stored?: readonly ProjectRelease[]): Promise<void> {
    const metrics = projectMetrics(this.metrics, project.id, { geo: false });
    const releases = stored ?? (await this.releaseRepository.list(project.id));
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

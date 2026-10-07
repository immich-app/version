import type { GitHubTokens } from './github-auth.js';
import { GitHubReleasesSource } from './github-source.js';
import { Metric, projectMetrics, type IMetricsRepository } from './metrics.js';
import { sameSource, type Project } from './projects.js';
import { errorClass, RateLimitError, REQUEST_TIMEOUT_MS, withDeadline, type ReleaseSource } from './sources.js';
import type { ProjectRelease } from './types.js';
import type { VersionService } from './version-service.js';

// The full-sync cron, matched by string equality. It must match wrangler.toml and worker.tf.
export const NIGHTLY_CRON = '0 3 * * *';

// How long one project's sync may take before the run moves on to the next.
// A full sync lists at most 3 pages, a request of REQUEST_TIMEOUT_MS each, and
// then confirms what it left out for at most RETRACTION_CHECK_BUDGET_MS, plus
// D1. Its release stats then get as long again.
export const PROJECT_DEADLINE_MS = 60_000;

export interface SourceCredentials {
  github: GitHubTokens;
}

// A new source type is a ReleaseSource built here, plus its loader and sourceKey() in src/projects.ts.
export function createSource(
  project: Project,
  credentials: SourceCredentials,
  timeoutMs = REQUEST_TIMEOUT_MS,
): ReleaseSource {
  const { source } = project;
  switch (source.type) {
    case 'github-releases': {
      return new GitHubReleasesSource(source, credentials.github.forRepository(source.repo), timeoutMs);
    }
  }
}

export interface SyncRunOptions {
  // The nightly run fetches every project in full.
  nightly: boolean;
  source: (project: Project) => ReleaseSource;
  deadlineMs?: number;
  // Runs after each project, to ship its metrics before the next one starts.
  afterProject?: () => void;
}

/**
 * Syncs every registered project, one after another. No project can stop the
 * rest: its sync and then its release stats each run under their own deadline,
 * its failure is logged and counted by a bounded `error_class`, and a rate
 * limit only skips the projects whose source shares it, for the rest of the run.
 */
export async function syncProjects(
  registry: readonly Project[],
  service: VersionService,
  metrics: IMetricsRepository,
  { nightly, source: sourceFor, deadlineMs = PROJECT_DEADLINE_MS, afterProject }: SyncRunOptions,
): Promise<void> {
  const rateLimited = new Set<string>();

  for (const project of registry) {
    const scoped = projectMetrics(metrics, project.id);
    const source = sourceFor(project);
    let releases: ProjectRelease[] | undefined;
    let failed = false;

    try {
      const result = await scoped.monitorAsyncFunction({ name: 'project_sync' }, () =>
        withDeadline(deadlineMs, async (signal) => {
          if (rateLimited.has(source.rateLimitKey)) {
            throw new RateLimitError(`Skipped: ${source.rateLimitKey} hit its rate limit earlier in this run`);
          }
          return await service.syncProject(project, source, {
            full: nightly,
            signal,
            sameSource: sameSource(project, registry),
          });
        }),
      )();
      releases = result.releases;
      console.log(
        `[cron] ${project.id}: ${result.mode} sync, ${result.written} written, ${result.deleted} deleted, ${result.skipped} skipped`,
      );
    } catch (error) {
      failed = true;
      const failure = errorClass(error);
      console.error(`[cron] ${project.id}: sync failed (${failure}):`, error);
      scoped.push(Metric.create('cron_error').addTag('error_class', failure).intField('count', 1));
      if (failure === 'rate_limited') {
        rateLimited.add(source.rateLimitKey);
      }
    }

    // 0 or 1 on every run, so the version-project-sync-failing alert can tell
    // whether the latest run failed: the error series only have failures.
    scoped.push(Metric.create('project_sync_outcome').intField('failed', Number(failed)));

    // After a failed sync too, so the stats keep describing what is stored. That
    // reads D1 again, which can stall like the sync, so it has a deadline too.
    try {
      await withDeadline(deadlineMs, () => service.emitReleaseStats(project, releases));
    } catch (error) {
      console.error(`[cron] ${project.id}: release stats failed (${errorClass(error)}):`, error);
    }

    afterProject?.();
  }
}

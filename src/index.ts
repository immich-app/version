import { DeferredRepository } from './deferred.js';
import { DocsService } from './docs-service.js';
import { createInstallationToken } from './github-auth.js';
import { GitHubRepository } from './github-repository.js';
import {
  clientTags,
  CloudflareMetricsRepository,
  getMetricsIdentity,
  HeaderMetricsProvider,
  InfluxMetricsProvider,
  Metric,
  projectMetrics,
  requestEdge,
} from './metrics.js';
import { legacyProject, type Project } from './projects.js';
import { ReleaseRepository } from './release-repository.js';
import type { GitHubRelease, VersionResponse } from './types.js';
import { VersionService } from './version-service.js';
import { verifyWebhookSignature } from './webhook.js';

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
  });
}

// http_response's method and path tags take only these values, anything else
// becomes 'other': raw values would let any client (or a scanner probing
// /wp-login.php) mint a new series per request in the shared o11y store.
// /changelog is gone but stays listed, so leftover callers still show up under
// its path, as 404s.
const METRIC_ROUTES = new Set(['/', '/health', '/version', '/v1/docs/versions', '/changelog', '/webhook']);
const METRIC_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

function httpResponseMetric(request: Request, url: URL, status: number) {
  return Metric.create('http_response')
    .addTag('method', METRIC_METHODS.has(request.method) ? request.method : 'other')
    .addTag('path', METRIC_ROUTES.has(url.pathname) ? url.pathname : 'other')
    .addTag('status', String(status))
    .intField('count', 1);
}

function createInfluxProvider(env: Env) {
  return new InfluxMetricsProvider(env.METRICS_URL ?? '', env.METRICS_TOKEN ?? '', getMetricsIdentity(env));
}

function errorResponse(error: string, status: number, extraHeaders?: Record<string, string>) {
  return jsonResponse({ error }, status, extraHeaders);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const deferredRepository = new DeferredRepository(ctx);
    const headerProvider = new HeaderMetricsProvider();
    const influxProvider = createInfluxProvider(env);
    deferredRepository.defer(() => influxProvider.flush());
    // Every series about a request carries its colo. The store keeps one
    // sample per series per 20s, so a counter split by colo loses fewer
    // requests than a single series would. continent and asOrg go only on the
    // series that are grouped by them.
    const edge = requestEdge(request);
    const metrics = new CloudflareMetricsRepository('version', [influxProvider, headerProvider], { colo: edge.colo });

    const releaseRepository = new ReleaseRepository(env.VERSION_DB);
    const versionService = new VersionService(releaseRepository, metrics);
    const docsService = new DocsService(releaseRepository, metrics);

    const url = new URL(request.url);

    const handleCacheableRequest = async (
      { name, project, maxAge }: { name: string; project: Project; maxAge: number },
      getData: () => Promise<unknown>,
    ): Promise<Response> => {
      const cache = caches.default;
      const cacheKey = new Request(url.href, request);
      const scoped = projectMetrics(metrics, project.id);

      if (env.ENVIRONMENT) {
        const cached = await cache.match(cacheKey);
        if (cached) {
          scoped.push(Metric.create(name).addTag('cache', 'cdn').intField('invocation', 1));
          return new Response(cached.body, cached);
        }
      }

      return await scoped.monitorAsyncFunction({ name }, async (): Promise<Response> => {
        const response = jsonResponse(await getData(), 200, { 'Cache-Control': `public, max-age=${maxAge}` });
        if (env.ENVIRONMENT) {
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
      })();
    };

    try {
      // Every request, with all of its edge's tags: the dashboards group all
      // traffic by continent ("Requests by Region") and by colo.
      const handleRequest = { name: 'handle_request', tags: { continent: edge.continent, asOrg: edge.asOrg } };
      const response = await metrics.monitorAsyncFunction(handleRequest, async () => {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Max-Age': '86400',
            },
          });
        }

        switch (url.pathname) {
          case '/health': {
            return jsonResponse({ status: 'ok' });
          }

          case '/version': {
            return await projectMetrics(metrics, legacyProject.id).monitorAsyncFunction(
              { name: 'version_request', tags: clientTags(request, legacyProject.analytics) },
              async (): Promise<Response> => {
                // we assume stable for backwards compatibility
                const channel = url.searchParams.get('channel') ?? 'stable';

                // Immich's channels are exactly stable and rc (src/projects.test.ts).
                if (!legacyProject.channels.has(channel)) {
                  return errorResponse('Invalid release channel. Expected "stable" or "rc"', 400);
                }

                const latest = await versionService.getLatestRelease(deferredRepository, legacyProject, channel);
                if (!latest) {
                  return errorResponse('No releases found', 404);
                }
                // Frozen shape: Immich servers read the raw tag as the version.
                return jsonResponse({
                  version: latest.tag,
                  published_at: latest.published_at,
                } satisfies VersionResponse);
              },
            )();
          }

          case '/v1/docs/versions': {
            return await handleCacheableRequest(
              { name: 'docs_versions_request', project: legacyProject, maxAge: 3600 },
              () => docsService.getArchivedVersions(legacyProject),
            );
          }

          case '/webhook': {
            if (request.method !== 'POST') {
              return errorResponse('Method Not Allowed', 405);
            }

            const signature = request.headers.get('X-Hub-Signature-256');
            if (!signature || !env.GITHUB_WEBHOOK_SECRET) {
              return errorResponse('Unauthorized', 401);
            }

            const body = await request.text();
            const isValid = await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
            if (!isValid) {
              return errorResponse('Unauthorized', 401);
            }

            metrics.push(
              Metric.create('webhook_received')
                .addTag('event', request.headers.get('X-GitHub-Event') ?? 'unknown')
                .intField('count', 1),
            );

            const event = request.headers.get('X-GitHub-Event');
            if (event !== 'release') {
              return jsonResponse({ ignored: true });
            }

            const payload = JSON.parse(body);
            if (payload.action !== 'published') {
              return jsonResponse({ ignored: true });
            }

            const releaseData = payload.release;
            if (!releaseData?.id || !releaseData?.tag_name) {
              return errorResponse('Invalid release payload', 400);
            }

            // Drafts are ignored, but pre-releases (rc builds) are stored to back the `rc` channel.
            if (releaseData.draft) {
              return jsonResponse({ ignored: true });
            }

            const release: GitHubRelease = {
              id: releaseData.id,
              tag_name: releaseData.tag_name,
              published_at: String(releaseData.published_at ?? ''),
              prerelease: releaseData.prerelease === true,
            };

            // The only hook is on immich-app/immich (webhook.tf), so every release is Immich's.
            await versionService.handleReleasePublished(legacyProject, release);
            return jsonResponse({ success: true });
          }

          default: {
            return errorResponse('Not Found', 404);
          }
        }
      })();

      metrics.push(httpResponseMetric(request, url, response.status));

      response.headers.set('Server-Timing', headerProvider.getTimingHeader());
      deferredRepository.runDeferred();
      return response;
    } catch (error) {
      console.error(error);
      metrics.push(httpResponseMetric(request, url, 500));
      deferredRepository.runDeferred();
      return errorResponse('Internal Server Error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const influxProvider = createInfluxProvider(env);
    // No request, so no geo tags. The runs' own series carry no project either:
    // version_cron_sync_invocation is the heartbeat, whatever the run syncs.
    const metrics = new CloudflareMetricsRepository('version', [influxProvider]);

    let githubToken: string | undefined;
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID) {
      githubToken = await createInstallationToken({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        installationId: Number(env.GITHUB_APP_INSTALLATION_ID),
      });
    }

    const githubRepository = new GitHubRepository(githubToken);
    const releaseRepository = new ReleaseRepository(env.VERSION_DB);
    const versionService = new VersionService(releaseRepository, metrics);
    const isNightly = event.cron === '0 3 * * *';

    try {
      if (isNightly) {
        const count = await metrics.monitorAsyncFunction({ name: 'cron_full_sync' }, () =>
          versionService.fullSync(legacyProject, githubRepository),
        )();
        console.log(`[cron] Nightly full sync: ${count} releases`);
      } else {
        const result = await metrics.monitorAsyncFunction({ name: 'cron_sync' }, () =>
          versionService.syncFromGitHub(legacyProject, githubRepository),
        )();
        console.log(`[cron] Synced ${result.synced} releases (full=${result.full})`);
      }
    } catch (error) {
      console.error('[cron] Sync failed:', error);
      metrics.push(
        Metric.create('cron_error')
          .addTag('error', error instanceof Error ? error.message : 'unknown')
          .intField('count', 1),
      );
    }

    // Always emit release count and latest version, even if sync failed
    try {
      await versionService.emitReleaseStats(legacyProject);
    } catch {
      // D1 might not be initialized yet
    }

    ctx.waitUntil(influxProvider.flush());
  },
};

import { DeferredRepository } from './deferred.js';
import { DocsService } from './docs-service.js';
import { GitHubTokens } from './github-auth.js';
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
import {
  findProject,
  LEGACY_PROJECT_ID,
  normalize,
  projects,
  projectsForGitHubRepository,
  requireProject,
  type Project,
} from './projects.js';
import { ReleaseRepository } from './release-repository.js';
import { REQUEST_TIMEOUT_MS } from './sources.js';
import { createSource, NIGHTLY_CRON, PROJECT_DEADLINE_MS, syncProjects } from './sync.js';
import type { GitHubRelease, ProjectVersionResponse, VersionResponse } from './types.js';
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

// The per-project route, tagged by its template whatever the id.
const PROJECT_VERSION_ROUTE = /^\/v1\/projects\/([^/]+)\/version$/;
const PROJECT_VERSION_TEMPLATE = '/v1/projects/:project/version';

function metricPath(pathname: string) {
  if (METRIC_ROUTES.has(pathname)) {
    return pathname;
  }
  return PROJECT_VERSION_ROUTE.test(pathname) ? PROJECT_VERSION_TEMPLATE : 'other';
}

function httpResponseMetric(request: Request, url: URL, status: number) {
  return Metric.create('http_response')
    .addTag('method', METRIC_METHODS.has(request.method) ? request.method : 'other')
    .addTag('path', metricPath(url.pathname))
    .addTag('status', String(status))
    .intField('count', 1);
}

function createInfluxProvider(env: Env) {
  return new InfluxMetricsProvider(env.METRICS_URL ?? '', env.METRICS_TOKEN ?? '', getMetricsIdentity(env));
}

function errorResponse(error: string, status: number, extraHeaders?: Record<string, string>) {
  return jsonResponse({ error }, status, extraHeaders);
}

// A webhook body as an object, or undefined if it isn't one.
function parsePayload(body: string): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(body) as unknown;
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkerOptions {
  // The registered projects. Tests pass their own rather than edit projects.json.
  projects?: readonly Project[];
  // How long a forge request, and a project's whole sync, may take.
  requestTimeoutMs?: number;
  projectDeadlineMs?: number;
}

export function createWorker({
  projects: registry = projects,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  projectDeadlineMs = PROJECT_DEADLINE_MS,
}: WorkerOptions = {}) {
  // The project the legacy routes serve.
  const legacyProject = requireProject(LEGACY_PROJECT_ID, registry);

  return {
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

      // /v1/projects/{id}/version: the newest release on one of a registered
      // project's channels. Unlike the legacy routes, it takes only GET and HEAD,
      // and only a 200 may be cached, so a browser never holds on to an error.
      const handleProjectVersion = async (id: string): Promise<Response> => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return errorResponse('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
        }

        const project = findProject(id, registry);
        if (!project) {
          return errorResponse('Unknown project', 404);
        }

        return await projectMetrics(metrics, project.id).monitorAsyncFunction(
          { name: 'version_request', tags: clientTags(request, project.analytics) },
          async (): Promise<Response> => {
            const channel = url.searchParams.get('channel') ?? project.defaultChannel;
            if (!project.channels.has(channel)) {
              return jsonResponse(
                { error: 'Invalid release channel', channels: [...project.channels].map(([name]) => name) },
                400,
              );
            }

            const latest = await versionService.getLatestRelease(deferredRepository, project, channel);
            if (!latest) {
              return errorResponse('No releases found', 404);
            }
            return jsonResponse(
              {
                project: project.id,
                channel,
                version: latest.version,
                tag: latest.tag,
                published_at: latest.published_at,
              } satisfies ProjectVersionResponse,
              200,
              { 'Cache-Control': 'public, max-age=300' },
            );
          },
        )();
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
                // The legacy routes keep their preflight byte for byte.
                'Access-Control-Allow-Methods': PROJECT_VERSION_ROUTE.test(url.pathname)
                  ? 'GET, HEAD, OPTIONS'
                  : 'GET, POST, OPTIONS',
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

              const payload = parsePayload(body);
              if (!payload) {
                return errorResponse('Invalid JSON payload', 400);
              }
              if (payload.action !== 'published') {
                return jsonResponse({ ignored: true });
              }

              const releaseData = payload.release as Record<string, unknown> | undefined;
              if (!releaseData?.id || !releaseData?.tag_name) {
                return errorResponse('Invalid release payload', 400);
              }

              // Drafts are ignored, but pre-releases (rc builds) are stored to back the `rc` channel.
              if (releaseData.draft) {
                return jsonResponse({ ignored: true });
              }

              const release: GitHubRelease = {
                id: releaseData.id as number,
                tag_name: releaseData.tag_name as string,
                published_at: String(releaseData.published_at ?? ''),
                prerelease: releaseData.prerelease === true,
              };

              // A signed delivery from a repository no project reads from stores nothing.
              const sourceProjects = projectsForGitHubRepository(payload.repository, registry);
              if (sourceProjects.length === 0) {
                metrics.push(Metric.create('webhook_ignored').addTag('reason', 'unknown_repo').intField('count', 1));
                return jsonResponse({ ignored: true });
              }

              // Every project on the repository whose pattern takes the tag stores it.
              const targets = sourceProjects.filter((project) => normalize(project, release.tag_name));
              if (targets.length === 0) {
                metrics.push(Metric.create('webhook_ignored').addTag('reason', 'unmatched_tag').intField('count', 1));
              }
              for (const project of targets) {
                await versionService.handleReleasePublished(project, release);
              }
              return jsonResponse({ success: true });
            }

            default: {
              const route = PROJECT_VERSION_ROUTE.exec(url.pathname);
              if (!route) {
                return errorResponse('Not Found', 404);
              }
              const response = await handleProjectVersion(route[1]);
              // The same status and headers, without the body.
              return request.method === 'HEAD' ? new Response(null, response) : response;
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
        const response = errorResponse('Internal Server Error', 500);
        // HEAD on the new route never has a body, failures included.
        return request.method === 'HEAD' && PROJECT_VERSION_ROUTE.test(url.pathname)
          ? new Response(null, response)
          : response;
      }
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      const influxProvider = createInfluxProvider(env);
      const flush = () => ctx.waitUntil(influxProvider.flush());
      // No request, so no geo tags. The run's own series carry no project either:
      // version_cron_sync_invocation is the heartbeat, whatever the run syncs.
      const metrics = new CloudflareMetricsRepository('version', [influxProvider]);
      const versionService = new VersionService(new ReleaseRepository(env.VERSION_DB), metrics);
      const credentials = { github: new GitHubTokens(env, requestTimeoutMs) };
      const nightly = controller.cron === NIGHTLY_CRON;
      const run = nightly ? 'cron_full_sync' : 'cron_sync';

      // The heartbeat ships before any project syncs, so none can hold it back.
      metrics.push(Metric.create(run).intField('invocation', 1));
      flush();

      try {
        await metrics.monitorAsyncFunction(
          { name: run },
          () =>
            syncProjects(registry, versionService, metrics, {
              nightly,
              source: (project) => createSource(project, credentials, requestTimeoutMs),
              deadlineMs: projectDeadlineMs,
              afterProject: flush,
            }),
          { monitorInvocations: false },
        )();
      } finally {
        flush();
      }
    },
  };
}

export default createWorker();

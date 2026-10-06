import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientTags,
  CloudflareMetricsRepository,
  getMetricsIdentity,
  InfluxMetricsProvider,
  Metric,
  projectMetrics,
  requestEdge,
  RESERVED_TAGS,
  type MetricsIdentity,
} from './metrics.js';

const identity: MetricsIdentity = {
  project: 'version',
  env: 'dev',
  cluster: 'version',
  provider: 'cloudflare',
  region: 'world',
};

const writeUrl = 'https://vmauth.example.com/insert/0/influx/write';

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
}

async function flushOne(provider: InfluxMetricsProvider, metric: Metric) {
  const fetchSpy = mockFetch();
  provider.pushMetric(metric);
  await provider.flush();
  expect(fetchSpy).toHaveBeenCalledOnce();
  const [, init] = fetchSpy.mock.calls[0];
  return String(init?.body);
}

// A request as it arrives at the worker, with Cloudflare's view of the client.
function edgeRequest(headers: Record<string, string> = {}) {
  const request = new Request('https://example.com/', { headers });
  Object.defineProperty(request, 'cf', { value: { continent: 'EU', colo: 'LHR', asOrganization: 'Example AS' } });
  return request;
}

// A repository on a request through LHR, and every metric pushed through it.
function recordingRepository() {
  const pushed: Metric[] = [];
  const recorder = {
    pushMetric: (metric: Metric) => {
      pushed.push(metric);
    },
    flush: () => {},
  };
  const repository = new CloudflareMetricsRepository('version', [recorder], { colo: 'LHR' });
  const tags = () => pushed.map((metric) => Object.fromEntries(metric.tags));
  return { repository, pushed, tags };
}

describe('Metric', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([...RESERVED_TAGS])('throws under tests when tagged %s, by addTag or addTags', (key) => {
    expect(() => Metric.create('version_x').addTag(key, 'x')).toThrow(`version_x can't be tagged ${key}`);
    expect(() => Metric.create('version_x').addTags({ colo: 'LHR', [key]: 'x' })).toThrow(
      `version_x can't be tagged ${key}`,
    );
  });

  it('drops and logs a reserved tag in production, keeping the rest', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = Metric.setReservedTagPolicy('drop');
    let metric: Metric;
    try {
      metric = Metric.create('version_x').addTags({ project: 'yucca', colo: 'LHR' }).addTag('env', 'prod');
    } finally {
      Metric.setReservedTagPolicy(previous);
    }

    expect(metric.tags).toEqual(new Map([['colo', 'LHR']]));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("version_x can't be tagged project"));
  });

  it('takes any other tag', () => {
    expect(Metric.create('version_x').addTags({ version_project: 'immich', projects: 'x' }).tags).toEqual(
      new Map([
        ['version_project', 'immich'],
        ['projects', 'x'],
      ]),
    );
  });
});

describe('getMetricsIdentity', () => {
  it('defaults to the version tenant labels, with env from ENVIRONMENT', () => {
    expect(getMetricsIdentity({ ENVIRONMENT: 'prod' })).toEqual({ ...identity, env: 'prod' });
  });

  it('prefers the bindings', () => {
    expect(
      getMetricsIdentity({
        ENVIRONMENT: 'dev',
        METRICS_PROJECT: 'p',
        METRICS_CLUSTER: 'c',
        METRICS_PROVIDER: 'v',
        METRICS_REGION: 'r',
      }),
    ).toEqual({ project: 'p', env: 'dev', cluster: 'c', provider: 'v', region: 'r' });
  });
});

describe('InfluxMetricsProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts line protocol with the identity labels and a bearer token', async () => {
    const fetchSpy = mockFetch();
    const provider = new InfluxMetricsProvider(writeUrl, 'token', identity);

    provider.pushMetric(Metric.create('version_cron_sync').addTag('colo', 'LHR').intField('invocation', 1));
    await provider.flush();

    expect(fetchSpy).toHaveBeenCalledWith(writeUrl, expect.objectContaining({ method: 'POST' }));
    const [, init] = fetchSpy.mock.calls[0];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
    expect(String(init?.body)).toMatch(
      /^version_cron_sync,cluster=version,colo=LHR,env=dev,project=version,provider=cloudflare,region=world invocation=1i \d+$/,
    );
  });

  it('still stamps the identity labels over a metric tag that got past the guard', async () => {
    const metric = Metric.create('version_x').intField('count', 1);
    // Metric.addTag refuses these keys; tags is the map underneath it.
    metric.tags.set('project', 'yucca').set('cluster', 'father').set('env', 'prod');

    const body = await flushOne(new InfluxMetricsProvider(writeUrl, 'token', identity), metric);

    expect(body).toContain(',cluster=version,env=dev,project=version,');
    expect(body).not.toContain('yucca');
  });

  it('escapes backslashes in tag values', async () => {
    const body = await flushOne(
      new InfluxMetricsProvider(writeUrl, 'token', identity),
      Metric.create('version_version_request').addTag('user_agent', 'curl\\ 8,x=y\\').intField('invocation', 1),
    );

    // curl\ 8,x=y\ -> backslashes doubled here, then the client escapes the space, comma and equals sign.
    expect(body).toContain(String.raw`,user_agent=curl\\\ 8\,x\=y\\ invocation=1i`);
  });

  it('caps tag values at 256 characters', async () => {
    const body = await flushOne(
      new InfluxMetricsProvider(writeUrl, 'token', identity),
      Metric.create('version_version_request').addTag('user_agent', 'a'.repeat(300)).intField('invocation', 1),
    );

    expect(body).toContain(`,user_agent=${'a'.repeat(256)} invocation=1i`);
  });

  it('keeps a backslash at the cap escaped', async () => {
    const body = await flushOne(
      new InfluxMetricsProvider(writeUrl, 'token', identity),
      Metric.create('version_version_request')
        .addTag('user_agent', String.raw`${'a'.repeat(255)}\tail`)
        .intField('invocation', 1),
    );

    expect(body).toContain(String.raw`,user_agent=${'a'.repeat(255)}\\ invocation=1i`);
  });

  it('keeps every line when several metrics are pushed', async () => {
    const fetchSpy = mockFetch();
    const provider = new InfluxMetricsProvider(writeUrl, 'token', { ...identity, env: 'prod' });

    provider.pushMetric(Metric.create('version_a').intField('count', 1));
    provider.pushMetric(Metric.create('version_b').intField('count', 2));
    await provider.flush();

    const lines = String(fetchSpy.mock.calls[0][1]?.body).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^version_a,.* count=1i /);
    expect(lines[1]).toMatch(/^version_b,.* count=2i /);
  });

  it('never logs the lines it ships, so client IPs stay out of Workers Logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = await flushOne(
      new InfluxMetricsProvider(writeUrl, 'token', identity),
      Metric.create('version_version_request').addTag('client_ip', '192.0.2.1').intField('invocation', 1),
    );

    expect(body).toContain('client_ip=192.0.2.1');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['no write URL', '', 'token', identity],
    ['no token', writeUrl, '', identity],
    ['no env', writeUrl, 'token', { ...identity, env: '' }],
  ])('logs the lines instead of shipping them with %s', async (_, url, token, id) => {
    const fetchSpy = mockFetch();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new InfluxMetricsProvider(url, token, id);

    provider.pushMetric(Metric.create('version_a').intField('count', 1));
    await provider.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^version_a,.* count=1i \d+$/));
  });
});

describe('CloudflareMetricsRepository', () => {
  it('prefixes metrics, tags them with its geo and leaves env to the provider', async () => {
    const { repository, pushed, tags } = recordingRepository();

    repository.push(Metric.create('http_response').intField('count', 1));
    await repository.monitorAsyncFunction({ name: 'handle_request', tags: { continent: 'EU' } }, async () => {})();

    expect(pushed.map((metric) => metric.name)).toEqual(['version_http_response', 'version_handle_request']);
    expect(tags()).toEqual([{ colo: 'LHR' }, { continent: 'EU', colo: 'LHR' }]);
  });

  it("scopes metrics to a project, on top of the parent's tags, without changing the parent", async () => {
    const { repository, tags } = recordingRepository();
    const scoped = projectMetrics(repository, 'immich');

    scoped.push(Metric.create('memory_cache_hit').intField('count', 1));
    await scoped.monitorAsyncFunction({ name: 'd1_get_latest' }, async () => {})();
    scoped.scoped({ cache: 'cdn' }).push(Metric.create('docs_versions_request').intField('invocation', 1));
    repository.push(Metric.create('http_response').intField('count', 1));

    expect(tags()).toEqual([
      { version_project: 'immich', colo: 'LHR' },
      { version_project: 'immich', colo: 'LHR' },
      { version_project: 'immich', cache: 'cdn', colo: 'LHR' },
      { colo: 'LHR' },
    ]);
  });

  it('leaves out the geo tags of a scope with geo: false, and of its scopes', () => {
    const { repository, tags } = recordingRepository();
    const stats = projectMetrics(repository, 'immich', { geo: false });

    stats.push(Metric.create('d1_release_count').intField('count', 3));
    stats.scoped({ channel: 'stable' }).push(Metric.create('latest_version').intField('count', 1));

    expect(tags()).toEqual([{ version_project: 'immich' }, { version_project: 'immich', channel: 'stable' }]);
  });

  it("lets a scope's tags win over a metric's own", () => {
    const { repository, tags } = recordingRepository();

    projectMetrics(repository, 'immich').push(
      Metric.create('x').addTag('version_project', 'other').intField('count', 1),
    );

    expect(tags()).toEqual([{ version_project: 'immich', colo: 'LHR' }]);
  });

  it('refuses a reserved key in a scope', () => {
    const { repository } = recordingRepository();

    expect(() => repository.scoped({ project: 'immich' }).push(Metric.create('x').intField('count', 1))).toThrow(
      "version_x can't be tagged project",
    );
  });
});

describe('requestEdge', () => {
  it("reads Cloudflare's view of where the request came in", () => {
    expect(requestEdge(edgeRequest())).toEqual({ continent: 'EU', colo: 'LHR', asOrg: 'Example AS' });
  });

  it('is empty without one', () => {
    expect(requestEdge(new Request('https://example.com/'))).toEqual({ continent: '', colo: '', asOrg: '' });
  });
});

describe('clientTags', () => {
  const headers = { 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'immich-server/v3.2.4' };

  it('identifies the client of a project with clientIdentity, by IP, user agent, continent and network', () => {
    expect(clientTags(edgeRequest(headers), { clientIdentity: true })).toEqual({
      client_ip: '192.0.2.1',
      user_agent: 'immich-server/v3.2.4',
      continent: 'EU',
      asOrg: 'Example AS',
    });
  });

  it('tags nothing for a project without it', () => {
    expect(clientTags(edgeRequest(headers), { clientIdentity: false })).toEqual({});
  });
});

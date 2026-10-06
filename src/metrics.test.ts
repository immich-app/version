import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareMetricsRepository,
  getMetricsIdentity,
  InfluxMetricsProvider,
  Metric,
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

  it('never lets a metric tag override an identity label', async () => {
    const body = await flushOne(
      new InfluxMetricsProvider(writeUrl, 'token', identity),
      Metric.create('version_x').addTags({ project: 'yucca', cluster: 'father', env: 'prod' }).intField('count', 1),
    );

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
  it('tags metrics with the request edge and leaves env to the provider', () => {
    const pushed: Metric[] = [];
    const request = new Request('https://example.com/');
    Object.defineProperty(request, 'cf', { value: { continent: 'EU', colo: 'LHR', asOrganization: 'Example AS' } });
    const repository = new CloudflareMetricsRepository('version', request, [
      {
        pushMetric: (metric) => {
          pushed.push(metric);
        },
        flush: () => {},
      },
    ]);

    repository.push(Metric.create('http_response').intField('count', 1));

    expect(pushed[0].name).toBe('version_http_response');
    expect(Object.fromEntries(pushed[0].tags)).toEqual({ continent: 'EU', colo: 'LHR', asOrg: 'Example AS' });
  });
});

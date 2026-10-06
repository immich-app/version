import { Point } from '@influxdata/influxdb-client';
import { type AsyncFn, type MonitorOptions, type Operation, monitorAsyncFunction } from './monitor.js';

export class Metric {
  private _tags = new Map<string, string>();
  private _timestamp = performance.now();
  private _fields = new Map<string, { value: number; type: 'duration' | 'int' }>();
  private constructor(private _name: string) {}

  static create(name: string) {
    return new Metric(name);
  }

  get tags() {
    return this._tags;
  }

  get timestamp() {
    return this._timestamp;
  }

  get fields() {
    return this._fields;
  }

  get name() {
    return this._name;
  }

  prefixName(prefix: string) {
    if (!this._name.startsWith(`${prefix}_`)) {
      this._name = `${prefix}_${this._name}`;
    }
  }

  addTag(key: string, value: string) {
    this._tags.set(key, value);
    return this;
  }

  addTags(tags: Record<string, string>) {
    for (const [key, value] of Object.entries(tags)) {
      this._tags.set(key, value);
    }
    return this;
  }

  durationField(key: string, duration?: number) {
    this._fields.set(key, { value: duration ?? performance.now() - this._timestamp, type: 'duration' });
    return this;
  }

  intField(key: string, value: number) {
    this._fields.set(key, { value, type: 'int' });
    return this;
  }
}

export interface IMetricsProviderRepository {
  pushMetric(metric: Metric): void;
  flush(): void | Promise<void>;
}

export interface IMetricsRepository {
  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options?: MonitorOptions,
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  push(metric: Metric): void;
}

export class HeaderMetricsProvider implements IMetricsProviderRepository {
  private _metrics: string[] = [];

  pushMetric(metric: Metric) {
    for (const [label, { value, type }] of metric.fields) {
      if (type !== 'duration') {
        continue;
      }

      const suffix = label === 'duration' ? '' : `_${label.replace('_duration', '')}`;
      this._metrics.push(`${metric.name}${suffix};dur=${value}`);
    }
  }

  getTimingHeader() {
    return this._metrics.join(', ');
  }

  flush() {
    console.log(this._metrics.join(', '));
  }
}

/**
 * The five identity labels every series shipped to FUTO's o11y stack carries
 * (yucca-o11y docs/05-shipping-metrics-guide.md, "Labels"). `project;cluster` is
 * also o11y's tenant key: its vminsert routes `version;version` to the version
 * tenant, where the recording rules and dashboards read, and anything else to
 * tenant 0.
 */
export interface MetricsIdentity {
  project: string;
  env: string;
  cluster: string;
  provider: string;
  region: string;
}

type MetricsIdentityBindings = Partial<
  Record<'ENVIRONMENT' | 'METRICS_PROJECT' | 'METRICS_CLUSTER' | 'METRICS_PROVIDER' | 'METRICS_REGION', string>
>;

/**
 * Terraform binds the values (worker.tf); the defaults only cover `wrangler dev`
 * and tests. A Worker runs on no particular cluster, so `cluster` names the kind
 * of infrastructure, and `region` is everywhere: the edge a request landed on is
 * the separate `colo` tag.
 */
export function getMetricsIdentity(env: MetricsIdentityBindings): MetricsIdentity {
  return {
    project: env.METRICS_PROJECT || 'version',
    env: env.ENVIRONMENT || '',
    cluster: env.METRICS_CLUSTER || 'version',
    provider: env.METRICS_PROVIDER || 'cloudflare',
    region: env.METRICS_REGION || 'world',
  };
}

// influxdb-client escapes spaces, commas and equals signs in tag values but not
// backslashes, so a value ending in one (a User-Agent is enough) escapes the
// separator after it and VictoriaMetrics rejects the whole request with a 400.
// Values are capped first, so a client-supplied header can't make an outsized label.
const MAX_TAG_VALUE_LENGTH = 256;
const escapeTagValue = (value: string) => value.slice(0, MAX_TAG_VALUE_LENGTH).replaceAll('\\', '\\\\');

export class InfluxMetricsProvider implements IMetricsProviderRepository {
  private metrics: string[] = [];

  constructor(
    private writeUrl: string,
    private token: string,
    private identity: MetricsIdentity,
  ) {}

  pushMetric(metric: Metric) {
    const point = new Point(metric.name);
    for (const [key, value] of metric.tags) {
      point.tag(key, escapeTagValue(value));
    }
    // Last, so no metric tag can shadow the labels o11y routes tenants and alerts on.
    for (const [key, value] of Object.entries(this.identity)) {
      point.tag(key, value);
    }
    for (const [key, { value }] of metric.fields) {
      point.intField(key, value);
    }
    const line = point.toLineProtocol()?.toString();
    if (line) {
      this.metrics.push(line);
    }
  }

  async flush() {
    if (this.metrics.length === 0) {
      return;
    }
    const body = this.metrics.join('\n');
    // Without env the series would reach o11y missing an identity label.
    if (!this.writeUrl || !this.token || !this.identity.env) {
      // Not shipping (wrangler dev, tests, PR stages): log the lines instead. A
      // shipping worker never logs them, so the client IPs and user agents they
      // carry stay out of Workers Logs.
      console.log(body);
      return;
    }
    const response = await fetch(this.writeUrl, {
      method: 'POST',
      body,
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      console.error('Failed to push metrics', response.status, response.statusText);
    }
    await response.body?.cancel();
  }
}

export class CloudflareMetricsRepository implements IMetricsRepository {
  private readonly defaultTags: Record<string, string>;

  constructor(
    private operationPrefix: string,
    request: Request,
    private metricsProviders: IMetricsProviderRepository[],
  ) {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    // The deployment's env is an identity label, stamped by InfluxMetricsProvider.
    this.defaultTags = {
      continent: cf?.continent ?? '',
      colo: cf?.colo ?? '',
      asOrg: cf?.asOrganization ?? '',
    };
  }

  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options: MonitorOptions = {},
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
    operation = { ...operation, tags: { ...operation.tags, ...this.defaultTags } };
    return monitorAsyncFunction(
      this.operationPrefix,
      operation,
      call,
      (metric) => {
        for (const provider of this.metricsProviders) {
          provider.pushMetric(metric);
        }
      },
      options,
    );
  }

  push(metric: Metric) {
    metric.prefixName(this.operationPrefix);
    metric.addTags(this.defaultTags);
    for (const provider of this.metricsProviders) {
      provider.pushMetric(metric);
    }
  }
}

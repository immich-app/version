import { Point } from '@influxdata/influxdb-client';
import { type AsyncFn, type MonitorOptions, type Operation, monitorAsyncFunction } from './monitor.js';

/**
 * Labels no metric may set. The first five are o11y's identity labels, which
 * InfluxMetricsProvider stamps on every line; `project;cluster` and the vm_*
 * labels pick the tenant; the rest belong to scrapes and alerting. A project's
 * id goes in `version_project` (projectMetrics()).
 */
export const RESERVED_TAGS: ReadonlySet<string> = new Set([
  'project',
  'env',
  'cluster',
  'provider',
  'region',
  'vm_account_id',
  'vm_project_id',
  'job',
  'instance',
  'severity',
  'alertname',
]);

export type ReservedTagPolicy = 'drop' | 'throw';

export class Metric {
  private static reservedTagPolicy: ReservedTagPolicy = 'drop';
  private _tags = new Map<string, string>();
  private _timestamp = performance.now();
  private _fields = new Map<string, { value: number; type: 'duration' | 'int' }>();
  private constructor(private _name: string) {}

  static create(name: string) {
    return new Metric(name);
  }

  /**
   * Sets what addTag does with a reserved tag, and returns the previous
   * policy. Production drops it and logs, so one bad key can't fail every
   * request. src/test/setup.ts makes tests throw, so the key never gets that far.
   */
  static setReservedTagPolicy(policy: ReservedTagPolicy): ReservedTagPolicy {
    const previous = this.reservedTagPolicy;
    this.reservedTagPolicy = policy;
    return previous;
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
    if (RESERVED_TAGS.has(key)) {
      const message = `${this._name} can't be tagged ${key}: o11y reserves that label`;
      if (Metric.reservedTagPolicy === 'throw') {
        throw new Error(message);
      }
      console.error(`[metrics] ${message}, dropped it`);
      return this;
    }
    this._tags.set(key, value);
    return this;
  }

  addTags(tags: Record<string, string>) {
    for (const [key, value] of Object.entries(tags)) {
      this.addTag(key, value);
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

export interface ScopeOptions {
  // false leaves out the request's geo tags (its colo), for a series about a
  // project as a whole that a request and a cron must write as one series.
  geo?: boolean;
}

export interface IMetricsRepository {
  monitorAsyncFunction<T extends AsyncFn>(
    operation: Operation,
    call: T,
    options?: MonitorOptions,
  ): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
  push(metric: Metric): void;
  // A repository whose metrics also carry these tags.
  scoped(tags: Record<string, string>, options?: ScopeOptions): IMetricsRepository;
}

/**
 * Scopes metrics to one project: its series carry its id as `version_project`,
 * never `project`, which is o11y's identity label.
 */
export function projectMetrics(metrics: IMetricsRepository, projectId: string, options?: ScopeOptions) {
  return metrics.scoped({ version_project: projectId }, options);
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

export interface RequestEdge {
  continent: string;
  colo: string;
  asOrg: string;
}

// Where a request entered Cloudflare's network.
export function requestEdge(request: Request): RequestEdge {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return { continent: cf?.continent ?? '', colo: cf?.colo ?? '', asOrg: cf?.asOrganization ?? '' };
}

/**
 * The tags the recording rules count a project's servers by: client IP, user
 * agent, continent and network. Only a project whose registry entry sets
 * analytics.clientIdentity gets them, so one whose clients are end-user
 * devices doesn't put a series per device in the shared store.
 */
export function clientTags(request: Request, { clientIdentity }: { clientIdentity: boolean }): Record<string, string> {
  if (!clientIdentity) {
    return {};
  }
  const { continent, asOrg } = requestEdge(request);
  return {
    client_ip: request.headers.get('CF-Connecting-IP') ?? '',
    user_agent: request.headers.get('User-Agent') ?? '',
    continent,
    asOrg,
  };
}

export class CloudflareMetricsRepository implements IMetricsRepository {
  constructor(
    private operationPrefix: string,
    private metricsProviders: IMetricsProviderRepository[],
    // The request's own tags: its colo on the request path, none on the crons.
    // The deployment's env is an identity label, stamped by InfluxMetricsProvider.
    private geo: Readonly<Record<string, string>> = {},
    private tags: Readonly<Record<string, string>> = {},
  ) {}

  scoped(tags: Record<string, string>, { geo = true }: ScopeOptions = {}): CloudflareMetricsRepository {
    return new CloudflareMetricsRepository(this.operationPrefix, this.metricsProviders, geo ? this.geo : {}, {
      ...this.tags,
      ...tags,
    });
  }

  // Added after a metric's own tags, so they win.
  private get defaultTags(): Record<string, string> {
    return { ...this.geo, ...this.tags };
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

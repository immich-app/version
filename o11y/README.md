# o11y bundle

The version worker's Grafana dashboards, its alert rules and its recording rules, shipped to FUTO's o11y stack ([immich-app/yucca-o11y](https://github.com/immich-app/yucca-o11y)) as one signed OCI artifact, `ghcr.io/immich-app/version/o11y-manifests:main`. This is Model A in yucca-o11y's `docs/06-dashboards-and-alerts-guide.md`.

| Source                  | Becomes                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| (generated)             | `GrafanaFolder` `version`, the project's folder in Grafana                 |
| `dashboards/<uid>.json` | a `GrafanaDashboard` with the JSON embedded as `spec.gzipJson`             |
| `alerts/*.yaml`         | `GrafanaAlertRuleGroup`s, shipped as-is                                    |
| `rules/*.yaml`          | `VMRule`s, shipped as-is and evaluated by the version tenant's own vmalert |

`render-manifests.sh` builds the bundle into `build/o11y` and rejects anything o11y would mis-apply. `.github/workflows/o11y.yml` runs it on every PR that touches this directory, and on `main` pushes the result with `flux push artifact` and signs it keyless with cosign.

```bash
# renders build/o11y, checks it assembles under kustomize and validates it with kubeconform
MISE_ENV=o11y mise run o11y:render
```

The bundle's tools (jq, yq, kustomize, kubeconform, flux2, cosign) and the `o11y:render` task are in `.mise/config.o11y.toml`, locked in `.mise/mise.o11y.lock`. Only `MISE_ENV=o11y` loads them, so the deploy and teardown jobs never install them. After changing a version there, re-lock with `MISE_ENV=o11y mise lock`.

## Where the data lives

The worker pushes Influx line protocol to o11y's vmauth gateway (`METRICS_URL`, `/insert/0/influx/write`). Prod ships to the production o11y store, and dev main to the staging one. PR stages ship nothing: they carry the same labels as dev main, so their series would merge into dev main's, and their crons would keep the staging heartbeat green while dev main's is dead. Every series carries the five identity labels, bound in `deployment/modules/cloudflare/workers/version/worker.tf`:

| Label      | Value                           |
| ---------- | ------------------------------- |
| `project`  | `version`                       |
| `env`      | `dev` or `prod` (`ENVIRONMENT`) |
| `cluster`  | `version`                       |
| `provider` | `cloudflare`                    |
| `region`   | `world`                         |

`project=version, cluster=version` is the tenant key: o11y's vminsert files those series under their own VictoriaMetrics tenant, `7:1`. Changing either value strands the data in tenant 0, out of reach of the recording rules.

Metric names are `<measurement>_<field>`, for example `version_handle_request_invocation`. On top of the identity labels and the operation's own tags:

- A series about one project carries its id from `projects.json` as `version_project`. The label is never `project`, which is the identity label above. The crons' run-level series, such as the `version_cron_sync_invocation` heartbeat, carry none.
- A series about a request carries `colo`, the Cloudflare edge it landed on. `version_handle_request` adds `continent` and `asOrg`, and so does `version_version_request` for projects that set `analytics.clientIdentity` (Immich), along with `client_ip` and `user_agent`.
- A project's release stats, `version_d1_release_count` and `version_latest_version`, carry no edge, so the webhook and the crons write the same series.
- A failed project sync is counted as `version_cron_error_count` with a bounded `error_class`, never the error message, which would make a series per error. Every run also writes each project's `version_project_sync_outcome_failed`, 1 if its sync failed and 0 if not, so the latest outcome can be read off one series.

`version_http_response` tags `method` and `path` only with the worker's own methods and routes, and `other` for anything else, so a scanner cannot create a series per request.

The token (`TF_VAR_o11y_vmauth_token` in `deployment/.env`) is FUTO's vmauth password, mirrored into immich's `tf_dev` and `tf_prod` vaults by core-infra-tf and baked into the worker at deploy time. After FUTO rotates it, apply core-infra-tf, then run the Build workflow on `main` (workflow_dispatch) to redeploy dev and prod.

The store keeps one sample per series per 20s. Counting events with `count_over_time` therefore gives a lower bound wherever one series takes more than one event in 20s, which mostly affects request totals without `client_ip`; `colo` on every request series spreads them out. The affected panels say so.

## Dashboards

Each `dashboards/<uid>.json` file is a Grafana export whose `uid` matches the file name. Every query uses the `$datasource` variable, which is limited to and defaults to `VictoriaMetrics Fleet` (uid `VictoriaMetricsFleet`). The default `VictoriaMetrics` datasource only sees the o11y cluster's own tenant and shows nothing here.

The overview has a `$project` variable over `version_project`. Its All value is `.*`, which also matches series from before the label existed. It filters the cache, D1, webhook, cron, release source, sync error, skipped tag and release panels, and "Requests by Project"; the panels about the worker as a whole ignore it. The server analytics dashboard is Immich's alone.

To change a dashboard, edit it in Grafana, export it with "Export for sharing externally" off, keep the `uid`, and save it over the file. Set `"id": null`. Add new dashboards the same way, with tags `app`, `metrics` and `version`.

## Alerts

Each `alerts/*.yaml` file holds one `GrafanaAlertRuleGroup` with `folderRef: version`. Every rule is labelled `project: version` and with a `severity`. o11y routes `project=version` to the `rootly-version` contact point, and Rootly sets urgency from the severity: `critical` is High and `warning` is Medium. Every query uses `datasourceUid: VictoriaMetricsFleet`. Never set `heartbeat: rootly`, which is o11y's own dead man's switch route.

`alerts/version.yaml` holds four rules:

- `version-cron-heartbeat` (critical). The `*/30` cron writes `version_cron_sync_invocation` at the start of every run and ships it before it syncs any project, so no project can hold it back. An hour without it, held for 15 minutes, means at least two missed runs. The absence is deliberately unguarded, so the alert keeps firing for as long as the outage lasts. A "seen in the last week" guard would not hold on Fleet: multitenant vmselect only discovers tenants that received samples on the query's UTC day, so the guard would resolve the alert at the next UTC midnight of a full outage. The alert ships in the same bundle as the tenant's vmalert, so it only exists where version reports.
- `version-recording-rules-stale` (warning). The tenant vmalert blackholes its own notifications, so this rule watches its output: `version:requests_immich:count5m` (written every 5 minutes), the derived `version:servers_unique:24h` and `:30d` while there is immich-server traffic, and vmalert's rule-error and dropped-row counters for `job="vmalert-version"`.
- `version-project-sync-failing` (warning), one alert per `version_project`. Each cron run syncs every project on its own, so one failing project leaves the heartbeat green. This fires when a project's sync failed in at least 3 of the last 4 runs and in the latest one, both read from `version_project_sync_outcome_failed`. The error series have no sample for a run that succeeds, so they can't say the latest run did; the outcome series can, and the alert resolves at the first run that succeeds. `version_cron_error_count`'s `error_class` (`rate_limited`, `auth`, `not_found`, `http`, `timeout`, `d1` or `other`) says why.
- `version-project-tags-skipped` (warning), one alert per `version_project`. Every sync counts the releases newer than the newest one the project recognizes whose tags no project on its source takes (`version_tags_skipped_count`). A project that changes its tag format keeps that above 0 while its syncs succeed and the service serves an old release, so a day of it fires the alert. Its last sample before that day must be above 0 too, or a new series (a newly registered project's), or one back from a day without samples, would fire on its first sample. It resolves once a newer release is recognized.

## Recording rules

`rules/version-recording.yaml` holds the `version:*` rules that the dashboards read, ported from immich-app/devtools. The memory cache rules and `version:requests_by_project:count5m` keep `version_project`, so the overview can filter them. o11y applies this bundle with `commonMetadata` label `o11y.futo.org/tenant: version`. A VMAlert named `version` selects VMRules carrying that label and evaluates them against tenant `7:1`. It adds the identity labels to every result, so the results land back in the same tenant. o11y's own vmalert skips VMRules carrying that label.

Rules must not set a namespace or a group `tenant`. They must not set an identity label (`project`, `cluster`, `env`, `provider`, `region`, or `vm_account_id`/`vm_project_id`) in a group's or a rule's `labels:` either. Those override the vmalert's external labels, so the results would be written into another tenant, and o11y does not stop that. `render-manifests.sh` rejects all of these, and any alerts or rules file with more than one YAML document.

A rule that combines a recorded `version:*` series with an aggregate must match on the aggregate's labels, for example `and on(client_ip)`, because the recorded series carry the identity labels and the aggregate does not.

o11y's vmselect caps each query at 1GB (`-search.maxMemoryPerQuery`), and a `[30d]` rollup inside a set operation is budgeted at about 1KB per `client_ip`. The rules that look back 30 days for new servers are therefore summed over four `client_ip` shards, which VictoriaMetrics evaluates one at a time. Shard any new rule of that shape the same way.

## Flux substitution

o11y substitutes `${VAR}` in everything it applies, and an unknown name becomes an empty string. Alerts and rules must not contain `${`. Dashboards are safe because their JSON is embedded gzipped.

## Distribution

The artifact is a single `application/vnd.cncf.flux.content.v1.tar+gzip` layer with no `kustomization.yaml`. kustomize-controller generates one. The CRs carry no namespace, and o11y's Kustomization sets `targetNamespace: o11y`.

It is signed keyless by this workflow's GitHub OIDC identity, which o11y's `OCIRepository` pins. To check a published artifact:

```bash
cosign verify ghcr.io/immich-app/version/o11y-manifests:main \
  --certificate-identity-regexp '^https://github\.com/immich-app/version/\.github/workflows/o11y\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The GHCR package must be public, because o11y pulls it anonymously. After the first publish, check that an anonymous pull works:

```bash
tok=$(curl -s "https://ghcr.io/token?scope=repository:immich-app/version/o11y-manifests:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $tok" https://ghcr.io/v2/immich-app/version/o11y-manifests/tags/list
```

If it is denied, an org admin sets the package to public in its package settings.

The consumer side is `kubernetes/apps/base/tenants/version/bundle.yaml` in yucca-o11y.

# Grafana-managed alerting

Every alert rule for the cluster lives here, as a Grafana alert-rule provisioning file, and
every notification goes to one Slack contact point, the Dreamwright alerts channel (#537).
Before #537 the same rules were Prometheus rules routed by Alertmanager to Telegram and Slack.
Prometheus now evaluates no rules and Alertmanager is off. One rule, `Watchdog`, is routed
elsewhere on purpose -- see "The Watchdog" below.

Prometheus's `ALERTS` series went with them. A dashboard panel that shows alerts is an
`alertlist` panel filtered by labels (`alertInstanceLabelFilter`), as on the email, fernfiles,
gpupoet and tinkerbell dashboards.

| File                 | What it provisions                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `notifications.yaml` | The `dreamwright-alerts-slack` and `watchdog-heartbeat` contact points, and the policy tree |
| `rules/<group>.yaml` | One rule group each, all in the `nas1` folder, evaluated every 1m                           |

## How it gets into Grafana

`configMapGenerator` in `../kustomization.yaml` packs these files into two ConfigMaps labelled
`grafana_alert=1`. The chart's alerts sidecar (`sidecar.alerts` in `../helmrelease.yaml`)
writes them to `/etc/grafana/provisioning/alerting` and calls Grafana's alerting provisioning
reload. A new file under `rules/` must also be listed in `../kustomization.yaml`, or it never
reaches Grafana.

Rules provisioned from a file can't be edited in the Grafana UI or through the API, and the
same goes for the contact point and the policy tree. Change the file here.

## Writing a rule

Copy an existing rule. Each one has the same shape:

- `query`: the PromQL, an instant query against the Prometheus datasource
  (`PBFA97CFB590B2093`).
- `firing`: `is_number($query) || is_nan($query) || is_inf($query)`, which fires for every series
  the query returns, the way a Prometheus rule does. Put the threshold in the PromQL (`> 0`),
  not in a Grafana expression.
- `noDataState: OK` and `missing_series_evals_to_resolve: 1`: an empty result or a series that
  disappears resolves the alert, again like Prometheus.
- `execErrState: Error`: if Prometheus can't be queried, Grafana fires a `DatasourceError`
  alert in place of the rule. Prometheus had no equivalent: it stayed silent when it could not
  evaluate.

Templates in annotations differ from Prometheus in three ways:

- `$value` is a string of every query's labels and value, not a number. Use
  `$values.query.Value`.
- There is no `query` function. A template can't run a second query.
- Grafana expands environment variables in labels, so a literal `$` in a label has to be
  written `$$`. Annotations and the query under `data` are not expanded, so `{{ $labels.x }}`
  stays as it is. Grafana 13.2 behaves this way; check again after a Grafana major.

Rule names stay project-qualified (`FernfilesPodNotReady`, not `PodNotReady`). The policy
groups by folder and alert name, so two rules with one name share a notification.

## The Slack webhook

The webhook URL is in `../.env.secret.grafana-alerts-slack.encrypted` (key `webhook_url`).
It reaches Grafana as `GRAFANA_ALERTS_SLACK_WEBHOOK_URL` (`envValueFrom` in
`../helmrelease.yaml`), and Grafana substitutes it into `notifications.yaml`. To set or rotate
it:

```
./scripts/onepassword-secrets.mts edit apps/production/monitoring/grafana/.env.secret.grafana-alerts-slack.encrypted
```

Grafana reads environment variables only at startup, so a new value takes effect once the
Grafana pod restarts.

## The Watchdog

Once #537 took Prometheus and Alertmanager out of the alerting path, Grafana is both the
evaluator and the notifier for every rule in this folder -- including the rule that would
otherwise have noticed Grafana itself was down. `rules/watchdog.yaml` holds one rule,
`Watchdog`, built to always fire, the same way every other rule here does (`is_number($query)
|| ...` against a query, `vector(1)`, that is never empty). `notifications.yaml` routes it
alone to the `watchdog-heartbeat` contact point -- a webhook, not Slack, on purpose -- every
`repeat_interval` (1m, matching the rule's own evaluation interval).

That webhook is a check-in ("dead man's switch") URL: a ping arriving on schedule is the
healthy case, and the service pages when pings stop. Any such service works
(healthchecks.io, Cronitor, Dead Man's Snitch, ...); none is wired up here, because signing
up for one is a one-time action for whoever owns this cluster, not something a rule file can
do. Until that happens, `GRAFANA_WATCHDOG_HEARTBEAT_URL` is the placeholder
`.env.secret.grafana-watchdog-heartbeat.encrypted` ships with, and the Watchdog pings
nowhere. To wire up a real one:

1. Create a check in the service of choice, with a period and grace period that comfortably
   cover a 1m repeat_interval plus a Grafana pod restart (a few minutes of grace is plenty).
2. Point the service's own alert at something that does **not** depend on this Grafana
   instance or its Slack webhook -- an email address, a different Slack app, etc. A path that
   shares a dependency with the thing it's watching defeats the point.
3. Put the check's ping URL in the secret:
   ```
   ./scripts/onepassword-secrets.mts edit apps/production/monitoring/grafana/.env.secret.grafana-watchdog-heartbeat.encrypted
   ```
4. Restart the Grafana pod (environment variables load at startup only) and confirm the
   service shows a ping within a couple of minutes.

No NetworkPolicy change is needed: the Grafana egress rule already allows outbound 443 to
the internet (`../../networkpolicy.yaml`, the `grafana` policy's last egress rule), which is
what carries the Slack webhook today and will carry this one the same way.

This is deliberately the smallest fix for "nothing notices if Grafana goes down": no new
workload, no NetworkPolicy change, and the only new secret is a URL. The cost is the
activation gap above (inert until someone signs up for a check-in service) and that, unlike
everything else alerting does, the Watchdog's own silence isn't itself visible from inside
this cluster -- by design, since that's exactly the failure it exists to cover.

## Checking a change locally

`kustomize build apps/production --enable-helm` checks that the ConfigMaps build. To check
that Grafana accepts the files, provision them into a throwaway Grafana with no network. The
Docker daemon here is remote, so copy files in rather than bind-mounting them:

```
docker create --name grafana-alerting-check --network none \
  -e GRAFANA_ALERTS_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/local \
  grafana/grafana:<version>
docker cp apps/production/monitoring/grafana/alerting/rules/. grafana-alerting-check:/etc/grafana/provisioning/alerting/
docker cp apps/production/monitoring/grafana/alerting/notifications.yaml grafana-alerting-check:/etc/grafana/provisioning/alerting/
# plus a file in provisioning/datasources/ declaring a Prometheus datasource with uid PBFA97CFB590B2093
docker start grafana-alerting-check
docker logs grafana-alerting-check 2>&1 | grep provisioning.alerting
docker exec grafana-alerting-check wget -Y off -qO- http://admin:admin@127.0.0.1:3000/api/v1/provisioning/alert-rules
```

Expect `finished to provision alerting` in the log and every rule in the API response. Grafana
accepts a broken annotation template without complaint (it stored `{{ $$labels.x }}` as is), so
read the annotations in that response too.

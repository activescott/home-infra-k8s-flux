# Monitoring Stack

Helm-managed observability stack deployed via Flux CD. Provides metrics (Prometheus), log aggregation (Loki + Alloy), and visualization (Grafana).

## How to Upgrade

### Step 1: Find the latest chart and app versions

Each Helm chart has its own version number that is separate from the application version it deploys. Use `helm search repo` to see the mapping:

```bash
# Update local repo caches first
helm repo update

# Show latest versions (chart version -> app version)
helm search repo grafana-community/grafana
helm search repo grafana-community/loki
helm search repo grafana/alloy
helm search repo prometheus-community/prometheus

# Show all available versions (useful for finding a specific app version)
helm search repo grafana-community/grafana --versions | head -20
```

For example, to find which chart version ships Grafana 12.4.2:

```bash
helm search repo grafana-community/grafana --versions | grep 12.4.2
# grafana-community/grafana    11.3.6    12.4.2    ...
```

### Step 2: Update the chart version

Edit `spec.chart.spec.version` in the corresponding `helmrelease.yaml` file listed in the table below.

### Step 3: Reconcile

Flux will pick up the change on its next interval (10m), or force it immediately:

```bash
flux reconcile helmrelease <name> -n monitoring
```

Verify:

```bash
flux get helmreleases -n monitoring
```

### Step 4 (Grafana major upgrades only): bump the pinned Drilldown plugins

Grafana's Drilldown apps (Logs, Metrics, Traces, Profiles) are downloaded into
the PVC at `/var/lib/grafana/plugins`, not baked into the image, so a Grafana
image upgrade leaves the old plugin build in place. Preinstalled plugins
auto-update on startup ["except for new major
versions"](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/#preinstall)
(`pluginchecker.CanUpdateVersion(..., onlyMinor=true)`, skip logged at debug
level only). A v1 plugin left behind under Grafana 13 fails to mount in the
browser — the page shows "App not found" even though
`/api/plugins/<id>/settings` reports it installed and enabled.

The versions are therefore pinned with the documented `plugin_id@version`
syntax in `grafana/helmrelease.yaml` under `grafana.ini.plugins.preinstall`;
a pinned version is installed whenever it differs from what is on disk. Pins
also stop auto-update, so they can be dropped once the new major is on the PVC
and re-added at the next major. After a Grafana major upgrade, re-pin each id
to the newest version the catalog reports as compatible:

```bash
for p in grafana-lokiexplore-app grafana-metricsdrilldown-app \
         grafana-exploretraces-app grafana-pyroscope-app; do
  echo "$p $(curl -sS -H 'grafana-version: 13.2.0' -H 'grafana-os: linux' \
    -H 'grafana-arch: amd64' \
    "https://grafana.com/api/plugins/$p/versions" | jq -r '.items[0].version')"
done
```

Verify after reconcile (`installed` should match the pin):

```bash
kubectl --context nas -n monitoring logs deploy/grafana -c grafana \
  | grep -i "plugin successfully installed"
```

### Helm Repositories

Grafana and Loki charts migrated from `grafana/helm-charts` to `grafana-community/helm-charts` in early 2026. Alloy has not migrated yet and still uses the original `grafana` repo. When Alloy migrates, remove the old `grafana` HelmRepository.

| Repo name              | URL                                                    | Charts served    | File                                                      |
| ---------------------- | ------------------------------------------------------ | ---------------- | --------------------------------------------------------- |
| `grafana-community`    | `https://grafana-community.github.io/helm-charts`      | Grafana, Loki    | `helmrepositories/grafana-community-helmrepository.yaml`  |
| `grafana`              | `https://grafana.github.io/helm-charts`                | Alloy            | `helmrepositories/grafana-helmrepository.yaml`            |
| `prometheus-community` | `https://prometheus-community.github.io/helm-charts`   | Prometheus       | `helmrepositories/prometheus-community-helmrepository.yaml` |

### Helm Chart Versions

| Component  | Chart                             | Chart Version | App Version | File                          |
| ---------- | --------------------------------- | ------------- | ----------- | ----------------------------- |
| Grafana    | `grafana-community/grafana`       | `11.3.6`      | `12.4.2`    | `grafana/helmrelease.yaml`    |
| Loki       | `grafana-community/loki`          | `9.3.3`       | `3.7.1`     | `loki/helmrelease.yaml`       |
| Alloy      | `grafana/alloy`                   | `1.5.2`       | `v1.12.2`   | `alloy/helmrelease.yaml`      |
| Prometheus | `prometheus-community/prometheus` | `28.6.0`      | `v3.9.1`    | `prometheus/helmrelease.yaml` |

## Architecture

```
                    ┌─────────────┐
                    │   Grafana   │  ← dashboards + explore
                    └──────┬──────┘
                     ┌─────┴─────┐
                     │           │
              ┌──────▼──┐   ┌───▼──────┐
              │  Loki   │   │Prometheus│  ← log + metric storage
              └──────▲──┘   └──────────┘
                     │
              ┌──────┴──┐
              │  Alloy  │  ← DaemonSet, tails pod logs via K8s API
              └─────────┘
```

- **Alloy** discovers all pods, attaches K8s metadata labels (namespace, pod, container, app), and pushes logs to Loki.
- **Prometheus** scrapes metrics from pods, kube-state-metrics (sub-chart), and external targets (gpupoet). Includes AlertManager (sub-chart) for Telegram notifications.
- **Grafana** is provisioned with both Prometheus and Loki as datasources.

### Adding a scrape target

Pick **one** of these — never both, or every metric will appear twice (one series per `job` label) and rules without a `job=` selector will fire duplicate alerts:

- **Pod annotation** (`prometheus.io/scrape: "true"` + `prometheus.io/port: "<n>"` on the pod template). Scraped by the chart's default `kubernetes-pods` job; series carry `job="kubernetes-pods"`. Use this for most pods.
- **Static `extraScrapeConfigs` entry** in `prometheus/helmrelease.yaml`. Series carry your chosen `job` label. Use this when you need a stable, readable job name for alert-rule selectors, or when the target isn't a pod (e.g. `gpupoet.com`).

## Storage

All data is on hostPath volumes. Prometheus and Grafana reuse their pre-existing paths to preserve historical data.

| Component  | Path                                                        | Backed up? |
| ---------- | ----------------------------------------------------------- | ---------- |
| Loki       | `/mnt/thedatapool/no-backup/app-data/loki`                  | No         |
| Prometheus | `/mnt/thedatapool/no-backup/app-data/prometheus/storage`    | No         |
| Grafana    | `/mnt/thedatapool/app-data/grafana/var-lib-grafana`         | Yes        |

## Accessing Grafana

Grafana is exposed at `https://grafana.activescott.com` via an Ingress with TLS (cert-manager).

### Grafana MCP Server (for Claude Code)

The [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana) server allows Claude Code to query Loki logs, Prometheus metrics, dashboards, and more directly through Grafana's API.

**Setup:**

1. Install: `brew install mcp-grafana`
2. Create a Grafana service account token:
   - Go to Administration > Users and access > Service accounts
   - Add a service account with **Viewer** role
   - Add a token and copy it
3. Set the token in your shell profile: `export GRAFANA_SERVICE_ACCOUNT_TOKEN="<token>"`
4. Add a `.mcp.json` at the repo root with the following content:
   ```json
   {
     "mcpServers": {
       "grafana": {
         "command": "mcp-grafana",
         "env": {
           "GRAFANA_URL": "https://grafana.activescott.com",
           "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_SERVICE_ACCOUNT_TOKEN}"
         }
       }
     }
   }
   ```
   The `${GRAFANA_SERVICE_ACCOUNT_TOKEN}` reference pulls the token from your shell environment at runtime.

**Key tools:**
- `mcp__grafana__query_loki_logs` - run LogQL queries against Loki
- `mcp__grafana__list_loki_label_names` / `list_loki_label_values` - explore available labels
- `mcp__grafana__query_prometheus` - run PromQL queries
- `mcp__grafana__search_dashboards` - find dashboards
- `mcp__grafana__list_datasources` - list configured datasources

**Loki datasource UID:** `P8E80F9AEF21F6940`

**Common log labels:** `namespace`, `pod`, `container`, `app`, `service_name`, `level`

## Log Collection Details

Alloy runs as a DaemonSet and collects logs from **all namespaces** with no exclusions. It attaches these labels to every log stream:

| Label          | Source                              |
| -------------- | ----------------------------------- |
| `namespace`    | Pod's Kubernetes namespace          |
| `pod`          | Pod name                            |
| `container`    | Container name                      |
| `app`          | Pod's `app` label                   |
| `service_name` | Synthetic: `namespace/app`          |
| `level`        | Log level (pino JSON logs only)     |

The Alloy pipeline also:
- Joins multi-line stack traces
- Drops health check logs (`GET /health/*` and `GET /api/health/*`)
- Parses pino JSON logs, extracting `level`, `msg`, and `module`
- Replaces raw JSON body with the parsed `msg` field for readability

Log retention is **180 days** (6 months).

### Plex File Log Collection

Plex writes most logs to files rather than stdout. Alloy collects these via a hostPath volume mount from `/mnt/thedatapool/app-data/plex/config/Library/Application Support/Plex Media Server/Logs`. File logs are labeled with `source="file"`, `namespace="plex"`, `app="plex"` and have a separate `loki.process "plex"` pipeline that parses the Plex log format (`Jan 27, 2026 12:39:48.421 [tid] LEVEL - message`). The `filename` structured metadata distinguishes individual log files.

Query example: `{namespace="plex", source="file"} | filename =~ ".*Plex Media Server.*"`

Plex file logs have a **30-day retention** (vs 180d default) configured via `retention_stream` in the Loki HelmRelease.

### Edge Firewall Syslog

The edge firewall ships **all** syslog facilities to Alloy over TCP, so its logs outlive the firewall's own local rotation (90 files) and become queryable in Grafana.

```
firewall syslog-ng --TCP/1514 RFC5424--> alloy-syslog Service --> loki.source.syslog --> Loki (180d)
```

- **`alloy-syslog`** (`alloy/syslog-service.yaml`) is a `LoadBalancer` Service exposing **only** port 1514. The chart's own Service stays `ClusterIP` so Alloy's UI/metrics port 12345 is not published to the LAN. k3s ServiceLB assigns the node address, so the firewall targets `10.1.111.20:1514`.
- **TCP, not UDP** — the WAN link-flap bursts this was built to catch are exactly when UDP datagrams get dropped.
- **RFC5424, not RFC3164** — RFC3164 timestamps carry neither year nor timezone, and these lines are correlated against ISP optical-line logs where exact times are the evidence. `use_incoming_timestamp` keeps the firewall's own timestamp rather than stamping on arrival.

Labels: `host`, `job="syslog"`, `namespace="network"`, `app="firewall"`, `service_name="network/firewall"`, plus `app_name` and `severity` promoted from the RFC5424 header by a `labelmap` rule. The component's other `__syslog_message_*` fields are deliberately not mapped — `hostname` is constant and `facility` is largely redundant with `app_name`; both would only add stream cardinality.

`app` and `service_name` both carry the word "firewall" on purpose: the `host` value alone is not a term anyone thinks to search for, so these make the stream findable in Drilldown's service picker and in label filters.

Volume is ~368 MB/day, dominated by `filterlog` (pf) and `unbound` (DNS) — together ~99% of lines. If query performance ever suffers, add a `retention_stream` override for those app_names — the same pattern Plex uses.

Query examples:

```logql
{app="firewall"}                                   # everything
{app="firewall", app_name="filterlog"}             # pf blocks
{app="firewall"} |= "igb0: link state changed"     # WAN link events
```

A **Firewall** dashboard (`grafana/dashboards/firewall.json`, uid `firewall-overview`) presents these: WAN drop counts over 1h/24h/7d, a drop-events bar chart, a WAN link-state log panel, log volume by application, and a filterable all-logs panel. It is logs-only, because logs are currently all we collect from the firewall — see below.

**Firewall-side config** lives in the OPNsense UI at _System > Settings > Logging / Targets_: Transport `TCP(4)`, Hostname `10.1.111.20`, Port `1514`, RFC5424 checked, Applications/Levels/Facilities left empty (= all).

#### WAN link alerting

Two `stage.metrics` counters in `loki.process "firewall"` feed the `edge-firewall` alert group in `prometheus/helmrelease.yaml`:

| Metric                                           | Alert                                     | Meaning                            |
| ------------------------------------------------ | ----------------------------------------- | ---------------------------------- |
| `loki_process_custom_wan_link_down_total`         | `WanLinkFlapping`, `WanLinkFlappingBurst` | WAN (`igb0`) carrier drops         |
| `loki_process_custom_firewall_syslog_lines_total` | `FirewallSyslogFeedDown`                  | Watchdog — the feed itself stopped |

The watchdog exists because carrier drops are rare: a flat drop counter cannot by itself distinguish "no drops" from "no data". The firewall logs continuously, so that second counter going flat is unambiguous.

Two gotchas worth preserving:

- **Alert expressions must aggregate with `sum()`.** `stage.metrics` counters inherit each log line's labels (`app_name`, `severity`, `pod`, ...), so they are many series, not one. Evaluated per-series, the feed-down alert fires whenever any single sporadically-logging application goes quiet.
- **`max_idle_duration` is set to `168h`** on both counters. The 5m default deletes the series between drops, leaving `increase()` nothing to measure.

Alloy is scraped via the pod-annotation method (`controller.podAnnotations`, port 12345) — do **not** also add a static `extraScrapeConfigs` entry for it, per the duplicate-series warning in "Adding a scrape target" above.

#### Firewall metrics (not yet collected)

OPNsense exposes no Prometheus or OTel endpoint natively. Two plugins are available in its repo (verified present, neither installed):

| Plugin | What it gives |
| ------ | ------------- |
| `os-node_exporter` | Prometheus node_exporter — scrape it with an `extraScrapeConfigs` entry |
| `os-telegraf` | Telegraf agent, incl. pf-specific inputs; push-based |

Caveat before assuming this replaces the log-derived WAN drop counter: node_exporter's FreeBSD collector coverage is narrower than Linux. CPU, memory, filesystem, and per-interface byte/packet/error counters are available, but `node_network_carrier_changes_total` is Linux-specific (it reads `/sys/class/net`, which FreeBSD does not have). Adding node_exporter would give throughput and error-rate context; the syslog-derived counter stays authoritative for carrier drops.

## Kubernetes audit log

**k3s on nas1 does not write one today.** Checked by looking for the stream in Loki: the only
`job` values are `loki.source.kubernetes.pods` and `syslog`, and nothing in this repo passes
the API server an audit flag. So the control-plane half of
activescott/activeassistant#348 is wired but not yet fed.

Everything downstream of the file is in place and reconciled by Flux: Alloy mounts
`/var/log/kubernetes/audit` (`DirectoryOrCreate`, so it is harmless while empty), tails
`*.log` there, and mints three counters that the `agent-sandbox-security` alert group reads.
Until the flags below are set, those counters stay at zero and the three audit alerts cannot
fire. **Their silence is not coverage.**

What remains is a node-level change, and k3s server flags on TrueNAS are Scott's to set.

### 1. Write the audit policy

Keep it narrow. A default-everything policy on this cluster is tens of MB a day of Flux and
kubelet chatter, and none of it is what #348 asks for. This one records the two things the
alerts read and drops the rest:

```bash
sudo mkdir -p /var/lib/rancher/k3s/server
sudo tee /var/lib/rancher/k3s/server/audit-policy.yaml >/dev/null <<'EOF'
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - RequestReceived
rules:
  # RBAC and NetworkPolicy writes in the sandbox namespaces. RequestResponse
  # so the alert can say what changed, not only that something did.
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete"]
    namespaces: ["agent-sandbox-k8s", "agent-sandbox-docker"]
    resources:
      - group: "rbac.authorization.k8s.io"
        resources: ["roles", "rolebindings"]
      - group: "networking.k8s.io"
        resources: ["networkpolicies"]
  # Services, also RequestResponse, and the level is the point rather than a
  # detail: SandboxServiceExternalIP looks for the word externalIPs in
  # the request body, and at Metadata the body is not there. Dropping this rule
  # to Metadata leaves an alert that can never fire and looks healthy.
  - level: RequestResponse
    verbs: ["create", "update", "patch"]
    namespaces: ["agent-sandbox-k8s", "agent-sandbox-docker"]
    resources:
      - group: ""
        resources: ["services"]
  # Everything else in the sandbox namespaces at Metadata, which is enough:
  # a Pod Security denial puts its reason in responseStatus.message, and
  # Metadata records responseStatus.
  - level: Metadata
    namespaces: ["agent-sandbox-k8s", "agent-sandbox-docker"]
  - level: None
EOF
sudo chmod 600 /var/lib/rancher/k3s/server/audit-policy.yaml
```

### 2. Create the log directory

```bash
sudo mkdir -p /var/log/kubernetes/audit
```

The path is not arbitrary: it is what Alloy's hostPath in `alloy/helmrelease.yaml` mounts, and
the two have to agree.

### 3. Pass the flags to the API server

```bash
sudo tee -a /etc/rancher/k3s/config.yaml >/dev/null <<'EOF'
kube-apiserver-arg:
  - audit-policy-file=/var/lib/rancher/k3s/server/audit-policy.yaml
  - audit-log-path=/var/log/kubernetes/audit/audit.log
  - audit-log-maxage=7
  - audit-log-maxbackup=3
  - audit-log-maxsize=100
EOF
sudo systemctl restart k3s
```

If `/etc/rancher/k3s/config.yaml` already has a `kube-apiserver-arg` key, merge into it rather
than appending a second one: k3s reads the last occurrence and silently drops the first.
If k3s here is started from a systemd unit's `ExecStart` rather than a config file, the same
five arguments go there as `--kube-apiserver-arg=...` instead.

### 4. Confirm

```bash
sudo ls -l /var/log/kubernetes/audit/
```

then, after a minute, in Grafana:

```logql
{app="kube-apiserver-audit"}
```

Two things to check while confirming, both of which fail silently:

- The file is created `0600 root:root`. Alloy's container runs as root (the chart sets no
  `securityContext` on it) so it can read that, but if the chart ever gains one, the tail goes
  quiet with no error anywhere.
- TrueNAS updates have been known to rewrite k3s configuration. Re-check after each one; a
  missing audit log looks exactly like a cluster where nothing happened.

Then force one of the alerts rather than waiting: apply a pod manifest the namespace's Pod
Security level forbids and watch `SandboxPodSecurityDenied`. The counters do not exist until
the first matching line, so an unverified selector and a quiet cluster are indistinguishable.

## Alert Runbooks

Runbooks live in `runbooks/`, one file per alert, added as alerts are diagnosed
rather than guessed up front (activescott/activeassistant#147). Each covered
rule's `runbook_url` annotation points at its file.

### Notes

- Loki has `auth_enabled: false`, so it can also be queried directly via port-forward: `kubectl --context nas port-forward -n monitoring svc/loki 3100:3100`

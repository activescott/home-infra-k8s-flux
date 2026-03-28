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

### Notes

- Loki has `auth_enabled: false`, so it can also be queried directly via port-forward: `kubectl --context nas port-forward -n monitoring svc/loki 3100:3100`

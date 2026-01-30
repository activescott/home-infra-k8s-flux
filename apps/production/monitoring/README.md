# Monitoring Stack

Helm-managed observability stack deployed via Flux CD. Provides metrics (Prometheus), log aggregation (Loki + Alloy), and visualization (Grafana).

## Helm Chart Versions

| Component  | Chart                                        | Version  | File                          | Releases                                                                                             |
| ---------- | -------------------------------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Loki       | `grafana/loki`                               | `6.51.0` | `loki/helmrelease.yaml`       | [Releases](https://github.com/grafana/loki/tree/main/production/helm/loki)                           |
| Alloy      | `grafana/alloy`                              | `1.5.2`  | `alloy/helmrelease.yaml`      | [Releases](https://github.com/grafana/alloy/tree/main/operations/helm)                               |
| Grafana    | `grafana/grafana`                            | `10.5.12`| `grafana/helmrelease.yaml`    | [Releases](https://github.com/grafana/helm-charts/tree/main/charts/grafana)                          |
| Prometheus | `prometheus-community/prometheus`            | `28.6.0` | `prometheus/helmrelease.yaml` | [Releases](https://github.com/prometheus-community/helm-charts/tree/main/charts/prometheus)          |

To bump a chart version, edit `spec.chart.spec.version` in the corresponding `helmrelease.yaml` file. Flux will reconcile the change automatically on the next interval (10m) or immediately via `flux reconcile helmrelease <name> -n monitoring`.

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
4. The `.mcp.json` at the repo root configures Claude Code to use the server

**Available capabilities:** Loki log queries (LogQL), Prometheus metric queries (PromQL), dashboard search/retrieval, alert rules, label exploration, and more.

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

### Notes

- Some apps (e.g. Plex) write most logs to files inside the container rather than stdout/stderr. Alloy only captures stdout/stderr via the Kubernetes API, so these file-based logs won't appear in Loki.
- Loki has `auth_enabled: false`, so it can also be queried directly via port-forward: `kubectl --context nas port-forward -n monitoring svc/loki 3100:3100`

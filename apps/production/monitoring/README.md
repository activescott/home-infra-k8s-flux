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

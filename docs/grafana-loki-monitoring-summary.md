# Implementation Summary: Grafana Loki Logging + Helm-Managed Monitoring Stack

Plan: [grafana-loki-monitoring-plan.md](./grafana-loki-monitoring-plan.md)

## Part A: Monitoring Stack (home-infra-k8s-flux repo)

All monitoring resources migrated from raw K8s manifests to Helm-managed charts via Flux CD.

### A1: HelmRepositories
- Created `apps/production/monitoring/helmrepositories/` with `grafana` and `prometheus-community` HelmRepository resources

### A2: Loki
- Created `apps/production/monitoring/loki/` with:
  - `helmrelease.yaml` - Loki 6.51.0, SingleBinary mode, 30d retention, filesystem storage
  - `loki-pv.yaml` - PV/PVC at `/mnt/thedatapool/no-backup/app-data/loki/`

### A3: Alloy
- Created `apps/production/monitoring/alloy/` with:
  - `helmrelease.yaml` - Alloy 1.5.2, DaemonSet mode, discovers all pods via `discovery.kubernetes`, pushes logs to Loki at `http://loki.monitoring.svc:3100/loki/api/v1/push`

### A4: Grafana
- Created `apps/production/monitoring/grafana/` with:
  - `helmrelease.yaml` - Grafana 10.5.12, provisioned datasources for both Prometheus and Loki
  - `grafana-pv.yaml` - PV/PVC at `/mnt/thedatapool/app-data/grafana/var-lib-grafana`
- Kept existing `certificate.yaml` and `grafana-ingress.yaml`
- Deleted old `grafana-statefulset.yaml` and `grafana-service.yaml`

### A5: Prometheus
- Created `apps/production/monitoring/prometheus/` with:
  - `helmrelease.yaml` - prometheus-community/prometheus 28.6.0, includes AlertManager (Telegram notifications) + kube-state-metrics sub-charts, migrated all scrape configs and alerting rules from old raw manifests
  - `prometheus-pv.yaml` - PV/PVC at existing hostPath (preserves historical data)
  - Moved `.env.secret.alertmanager.encrypted` from old prometheus-alertmanager dir
- Rewrote `kustomization.yaml` with secretGenerator for prometheus-secrets and alertmanager-secrets, configMapGenerator for web.yaml
- Deleted old `prometheus-statefulset.yaml`, `prometheus-service.yaml`, `authorize-prometheus-to-k8s.yaml`, and `config/` directory

### A6: Blackbox Exporter
- Created `apps/production/monitoring/blackbox-exporter/` with:
  - `helmrelease.yaml` - prometheus-community/prometheus-blackbox-exporter 11.7.0, migrated `gpupoet_cache_updater` HTTP probe module

### A7: Cleanup
- Rewrote top-level `apps/production/monitoring/kustomization.yaml` to reference new Helm-managed directories
- Deleted old directories: `prometheus-alertmanager/`, `prometheus-blackbox-exporter/`, `kube-state-metrics/` (production and base)
- Verified `kubectl kustomize` builds successfully

---

## Part B: App Logging (pino migration)

### B1: gpupoet (gpu-poet repo, ~30 files)
- Created `packages/web-app/src/lib/logger.ts` - pino logger with `createLogger()` function
- Created `packages/ebay-client/src/logger.ts` - same pattern for ebay-client package
- Replaced `@activescott/diag` with pino across all server-side files (~20 files):
  - All `import { createDiag } from "@activescott/diag"` → `import { createLogger } from "@/lib/logger"`
  - All `const log = createDiag("shopping-agent:xyz")` → `const log = createLogger("xyz")`
  - Restructured all log calls to pino's object-first pattern: `log.error({ err: error, key: val }, "message")`
- Replaced client-side files (~6 files) with console-based loggers (pino doesn't run in browsers)
- Updated `packages/web-app/package.json`: replaced `@activescott/diag` with `pino`, added `pino-pretty` as devDep, removed `DEBUG=shopping-agent:*` from scripts
- Updated `packages/ebay-client/package.json`: replaced `@activescott/diag` with `pino`

### B2: ramblefeed (ramblefeed repo, 10 files)
- Created `packages/web-app/app/lib/logger.ts` - pino logger (name: "ramblefeed")
- Added `pino` to dependencies, `pino-pretty` to devDependencies
- Migrated 10 server-side files from `console.*` to pino structured logging:
  - `lib/repositories/tag.ts`, `lib/repositories/note.ts`
  - `lib/services/storage.ts`, `lib/services/snapshot.ts` (11 calls), `lib/services/unfurl.ts`
  - `routes/profile.tsx`, `routes/health.readiness.tsx`, `routes/ph.$.ts`
  - `lib/database.ts`
- Kept `lib/environment.ts` as `console.error` (early bootstrap validation code)

### B3: tayle (tayle repo, 2 files)
- Removed `| pino-pretty` from `apps/app/package.json` start script
- Removed `| npx pino-pretty` from `apps/worker/package.json` start script
- Moved `pino-pretty` from `dependencies` to `devDependencies` in both packages
- Dev scripts still pipe through pino-pretty for local development

### B4: tinkerbell - No changes needed (already uses pino correctly)
### B5: scott.willeke.com - No changes needed (static site, Nginx logs collected by Alloy)

---

## Repos with uncommitted changes

1. **home-infra-k8s-flux** - monitoring stack Helm migration (Part A)
2. **gpu-poet** - pino migration (Part B1)
3. **ramblefeed** - pino logger addition (Part B2)
4. **tayle** - production start script fixes (Part B3)

## Post-deploy verification

See the Verification section in the [plan](./grafana-loki-monitoring-plan.md#verification) for the full checklist.

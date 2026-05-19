# Plan: Grafana Loki Logging + Helm-Managed Monitoring Stack

## Overview

Replace the entire `monitoring` namespace (currently raw K8s manifests) with a Helm-managed observability stack, and add Loki-based centralized logging. Update apps to output structured JSON logs via pino for app-level logging optimized for Loki.

**Log format decision**: Accept mixed-format logs. Framework-level HTTP request logs (react-router-serve, Next.js) remain plain text. App-level pino logs output NDJSON. Loki handles both formats — plain text is full-text searchable, JSON lines are parseable for structured queries. This avoids replacing the built-in HTTP servers in tinkerbell/ramblefeed/gpupoet.

**Helm charts (all official/widely-used):**
- `grafana/loki` - Log storage (SingleBinary mode)
- `grafana/alloy` - Log collection agent (DaemonSet)
- `grafana/grafana` - Visualization (single instance for metrics + logs)
- `prometheus-community/prometheus` - Metrics (includes AlertManager + kube-state-metrics sub-charts)
- `prometheus-community/prometheus-blackbox-exporter` - HTTP probing

---

## Part A: Monitoring Stack

### A1. New Directory Structure

```
apps/production/monitoring/
  kustomization.yaml              # REWRITE - reference new Helm dirs
  namespace.yaml                  # KEEP as-is
  helmrepositories/
    kustomization.yaml            # NEW
    grafana-helmrepository.yaml   # NEW
    prometheus-community-helmrepository.yaml  # NEW
  loki/
    kustomization.yaml            # NEW
    helmrelease.yaml              # NEW
    loki-pv.yaml                  # NEW (PV+PVC for hostPath)
  alloy/
    kustomization.yaml            # NEW
    helmrelease.yaml              # NEW
  prometheus/
    kustomization.yaml            # REWRITE
    helmrelease.yaml              # NEW (replaces statefulset + all config)
    prometheus-pv.yaml            # NEW (PV+PVC for existing hostPath)
    certificate.yaml              # KEEP from existing
    prometheus-ingress.yaml       # KEEP from existing (extract from statefulset file)
    web.yaml                      # KEEP from existing config/
    .env.secret.prometheus-self-scrape.encrypted  # KEEP
    .env.secret.alertmanager.encrypted            # MOVE from prometheus-alertmanager/
  grafana/
    kustomization.yaml            # REWRITE
    helmrelease.yaml              # NEW (replaces statefulset)
    grafana-pv.yaml               # NEW (PV+PVC for existing hostPath)
    certificate.yaml              # KEEP from existing
    grafana-ingress.yaml          # KEEP from existing (extract from statefulset file)
  blackbox-exporter/
    kustomization.yaml            # NEW
    helmrelease.yaml              # NEW
```

**Directories to remove after migration:**
- `apps/production/monitoring/prometheus-alertmanager/` (now a sub-chart of prometheus)
- `apps/production/monitoring/prometheus-blackbox-exporter/` (replaced by Helm chart)
- `apps/production/monitoring/kube-state-metrics/` (now a sub-chart of prometheus)
- `apps/base/monitoring/kube-state-metrics/` (no longer needed)

### A2. HelmRepositories

File: `apps/production/monitoring/helmrepositories/grafana-helmrepository.yaml`
```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: grafana
  namespace: monitoring
spec:
  interval: 168h
  url: https://grafana.github.io/helm-charts
```

File: `apps/production/monitoring/helmrepositories/prometheus-community-helmrepository.yaml`
```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: prometheus-community
  namespace: monitoring
spec:
  interval: 168h
  url: https://prometheus-community.github.io/helm-charts
```

### A3. Loki HelmRelease

File: `apps/production/monitoring/loki/helmrelease.yaml`

Key values:
- `deploymentMode: SingleBinary` (appropriate for single-node cluster)
- `loki.auth_enabled: false`
- `loki.commonConfig.replication_factor: 1`
- `loki.schemaConfig` with TSDB + filesystem storage
- `singleBinary.replicas: 1`, reference `existingClaim: loki-storage-pvc`
- Disable read/write/backend replicas, gateway, minio, self-monitoring, canary, caches
- Add `loki.limits_config.retention_period: 30d` and `loki.compactor.retention_enabled: true`

Storage PV: hostPath at `/mnt/thedatapool/no-backup/app-data/loki/`

### A4. Alloy HelmRelease

File: `apps/production/monitoring/alloy/helmrelease.yaml`

Key values:
- `controller.type: daemonset`
- `mounts.varlog: true`
- RBAC + ServiceAccount enabled
- Alloy config (inline in values):
  - `discovery.kubernetes "pods"` - discover all pods
  - `discovery.relabel "pods"` - extract namespace, pod, container, app labels
  - `loki.source.kubernetes "pods"` - tail pod logs
  - `loki.write "default"` - push to `http://loki.monitoring.svc:3100/loki/api/v1/push`
- Alloy is **only** for log collection; Prometheus handles metrics separately

### A5. Prometheus HelmRelease

File: `apps/production/monitoring/prometheus/helmrelease.yaml`

Chart: `prometheus-community/prometheus` (no official Grafana Prometheus chart exists; this is the de facto standard with 15k+ GitHub stars)

Key values:
- **server**: retention 30d/100GB, `existingClaim: prometheus-storage-pvc`, securityContext uid/gid 4030, extraFlags for web.config.file + lifecycle, extraConfigmapMounts for web.yaml, extraSecretMounts for prometheus-secrets, ingress disabled (managed separately)
- **alertmanager**: enabled, extraSecretMounts for alertmanager-secrets (Telegram bot token)
- **alertmanagerFiles**: Migrate existing config verbatim from `apps/production/monitoring/prometheus-alertmanager/config/alertmanager.yaml` - route to `on_call_operator_default`, Telegram chat_id 510755639, bot_token_file path updated to match new mount
- **serverFiles.alerting_rules.yml**: Migrate all rules from `config/alerting-rules.gpupoet.yaml` and `config/alerting-rules.tayle.yaml`
- **extraScrapeConfigs**: Migrate gpupoet external scrape (`gpupoet.com/ops/metrics`) and prometheus self-scrape with basic auth. The chart already handles kubernetes-apiservers, kubernetes-nodes, kubernetes-pods, and kubernetes-service-endpoints scraping via built-in configs.
- **kube-state-metrics**: enabled (sub-chart)
- **prometheus-node-exporter**: disabled (optional, can enable later)
- **prometheus-pushgateway**: disabled

Secrets: Continue using kustomize `secretGenerator` with SOPS-encrypted `.env` files. The HelmRelease references the resulting K8s Secret objects by name via `extraSecretMounts`.

Storage PV: existing hostPath at `/mnt/thedatapool/no-backup/app-data/prometheus/storage` (preserves historical data)

### A6. Grafana HelmRelease

File: `apps/production/monitoring/grafana/helmrelease.yaml`

Key values:
- `persistence.enabled: true`, `existingClaim: grafana-storage-pvc`
- securityContext uid/gid 4020
- **datasources** provisioned via values:
  - Prometheus: `http://prometheus-server.monitoring.svc:80` (default)
  - Loki: `http://loki.monitoring.svc:3100`
- ingress disabled (managed separately via existing Ingress + cert-manager Certificate)
- podAnnotations for Prometheus scraping (port 3000)

Storage PV: existing hostPath at `/mnt/thedatapool/app-data/grafana/var-lib-grafana` (preserves dashboards)

### A7. Blackbox Exporter HelmRelease

File: `apps/production/monitoring/blackbox-exporter/helmrelease.yaml`

Chart: `prometheus-community/prometheus-blackbox-exporter`

Key values:
- Migrate existing module config: `gpupoet_cache_updater` HTTP prober with 30s timeout, 5MB body limit, follow redirects, IPv4 preferred

### A8. Top-Level Monitoring Kustomization (rewritten)

```yaml
# apps/production/monitoring/kustomization.yaml
resources:
  - ./namespace.yaml
  - ./helmrepositories
  - ./loki
  - ./alloy
  - ./prometheus
  - ./grafana
  - ./blackbox-exporter
namespace: monitoring
buildMetadata: [originAnnotations, transformerAnnotations]
```

### A9. Migration Order

1. **Add HelmRepositories** alongside existing stack (non-destructive). Commit, verify Flux reconciles.
2. **Deploy Loki + Alloy** (entirely new, no conflicts). Commit, verify logs flowing.
3. **Deploy new Grafana HelmRelease** (new directory `grafana/` with HelmRelease replacing old StatefulSet). Remove old grafana resources. Same hostPath preserves dashboards. Commit, verify Grafana accessible with both datasources.
4. **Deploy new Prometheus HelmRelease** + Blackbox Exporter. Remove old prometheus, prometheus-alertmanager, prometheus-blackbox-exporter, kube-state-metrics directories. Same hostPath preserves metrics data. Commit, verify scrape targets, alerts, Telegram notifications.
5. **Cleanup** - Remove old `apps/base/monitoring/kube-state-metrics/` directory.

**Safety**: Use `flux suspend kustomization apps` before the cutover commits if worried about partial reconciliation, then `flux resume` after pushing.

---

## Part B: App Logging (pino)

### B1. gpupoet - Replace @activescott/diag with pino

**Scope**: ~30 files across `packages/web-app/` and `packages/ebay-client/`

**Current state**: Uses `@activescott/diag` which wraps the `debug` npm package. API: `createDiag("name")` returns `{ debug, info, warn, error, assert }`. Output goes to stderr via DEBUG env var as plain text (`TIMESTAMP namespace:module:level message`), not structured JSON. Next.js HTTP request logs are also plain text — accepted as-is per the mixed-format decision.

**Changes needed**:

1. Add `pino` dependency to `packages/web-app/package.json` and `packages/ebay-client/package.json`
2. Create `packages/web-app/src/lib/logger.ts` following tinkerbell's pattern:
   ```typescript
   import pino from "pino"
   const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")
   export const logger = pino({ name: "gpupoet", level })
   export function createLogger(name: string) { return logger.child({ module: name }) }
   export type Logger = pino.Logger
   ```
3. Create `packages/ebay-client/src/logger.ts` with same pattern (name: "ebay-client")
4. Replace all `import { createDiag } from "@activescott/diag"` / `const log = createDiag("shopping-agent:xyz")` with `import { createLogger } from "../lib/logger"` / `const log = createLogger("xyz")`
5. Handle **client-side files** (React components like `SortPanel.tsx`, `ListingGallery.tsx`, `ClientRedirect.tsx`, `provider.tsx`, `reporter.tsx`, `GoogleAdsTag.tsx`): These run in the browser where pino doesn't work. Replace with `console.debug/info/warn/error` or a simple browser-compatible wrapper. These logs don't reach Loki anyway (browser-only).
6. Handle `assert` calls: Replace `log.assert(cond, msg)` with a conditional `if (!cond) log.error(msg)` or use Node's `assert` module.
7. Remove `@activescott/diag` from dependencies
8. Remove `DEBUG=shopping-agent:*` from npm scripts (no longer needed; pino uses LOG_LEVEL)
9. Add `pino-pretty` as devDependency for local development

**Key files to modify** (server-side, partial list):
- `packages/web-app/src/app/sitemap.ts`
- `packages/web-app/src/app/ops/revalidate-cache/route.ts`
- `packages/web-app/src/app/ops/cleanup-listings/route.ts`
- `packages/web-app/src/pkgs/server/listings/cleanup.ts`
- `packages/web-app/src/pkgs/server/listings/listings.ts`
- `packages/web-app/src/pkgs/server/data/ModelRepository.ts`
- `packages/web-app/src/pkgs/server/data/MetricRepository.ts`
- `packages/web-app/src/pkgs/server/path.ts`
- `packages/web-app/src/pkgs/server/listingFilters.ts`
- `packages/web-app/src/pkgs/isomorphic/retry.ts`
- `packages/web-app/src/app/gpu/...` (multiple page.tsx files)
- `packages/web-app/src/app/ml/...` (multiple page.tsx files)
- `packages/ebay-client/src/buy/buy.ts`

**Source repo**: `/Users/scott/src/activescott/gpu-poet`

### B2. ramblefeed - Add pino

**Scope**: Minimal - currently uses `console.log` only in seed files and has no structured logging.

**Changes needed**:

1. Add `pino` to `packages/web-app/package.json` dependencies, `pino-pretty` as devDependency
2. Create `packages/web-app/app/lib/logger.ts` following tinkerbell's pattern (name: "ramblefeed")
3. Replace `console.log` calls in seed files and any other server-side code with the new logger
4. HTTP request logs come from `react-router-serve` (plain text, same as tinkerbell) — accepted as-is, no pino-http needed
5. Verify the production start command (`react-router-serve ./build/server/index.js`) does NOT pipe through pino-pretty (confirmed: it does not)

**Source repo**: `/Users/scott/src/activescott/ramblefeed`

### B3. tayle - Fix production pino-pretty piping

**Scope**: Small but critical fix.

**Current problem**: Both `apps/app/package.json` and `apps/worker/package.json` have their `start` scripts piping through `pino-pretty`:
- `"start": "node build/server-express/server-express/start.js | pino-pretty"`
- `"start": "node dist/index.js | npx pino-pretty"`

This converts structured JSON to human-readable text, preventing Loki from parsing structured log fields.

**Changes needed**:

1. `apps/app/package.json`: Change `start` to `"node build/server-express/server-express/start.js"` (remove `| pino-pretty`)
2. `apps/worker/package.json`: Change `start` to `"node dist/index.js"` (remove `| npx pino-pretty`)
3. Keep `pino-pretty` piping in `dev` scripts (local development only)
4. Ensure `pino-pretty` remains in devDependencies (not removed entirely)

**Source repo**: `/Users/scott/src/tayle-co/tayle`

### B4. tinkerbell - No changes needed

Already uses pino with proper structured JSON output in production. Logger at `packages/web-app/app/lib/logger.ts` correctly outputs JSON when `NODE_ENV === "production"`. HTTP request logs from `react-router-serve` are plain text — accepted as-is per the mixed-format decision.

### B5. scott.willeke.com - No changes needed

Static site served by Nginx. Nginx access/error logs are written to stdout/stderr automatically and will be collected by Alloy. No application-level logging applicable.

---

## Verification

### Monitoring Stack
1. `flux get helmrepositories -n monitoring` - all repos show "Ready"
2. `flux get helmreleases -n monitoring` - all releases show "Ready"
3. `kubectl get pods -n monitoring` - all pods Running
4. Access `grafana.activescott.com` - verify login works, both Prometheus and Loki datasources appear
5. In Grafana Explore, select Loki datasource, query `{namespace="monitoring"}` - verify logs appear
6. In Grafana Explore, select Prometheus datasource, query `up` - verify metrics targets
7. Access `prometheus.activescott.com` - verify Prometheus UI accessible with basic auth
8. Prometheus UI → Status → Targets - verify all scrape targets are up
9. Prometheus UI → Alerts - verify alert rules loaded (gpupoet, tayle)
10. Test Telegram alert by temporarily creating a condition that fires

### App Logging
1. **gpupoet**: `cd /Users/scott/src/activescott/gpu-poet && npm run dev` - verify structured JSON output from server-side code, pino-pretty in terminal
2. **ramblefeed**: `cd /Users/scott/src/activescott/ramblefeed && npm run dev` - verify pino logger output
3. **tayle**: `cd /Users/scott/src/tayle-co/tayle && npm run start --workspace=apps/app` - verify raw JSON (no pino-pretty in production start)
4. After deploying updated app images: In Grafana Explore, select Loki, query `{namespace="gpupoet-prod"}` or similar - verify structured JSON log lines with parseable fields

---

## Critical Files Reference

### Existing files to modify/replace:
- `apps/production/monitoring/kustomization.yaml` - rewrite
- `apps/production/monitoring/prometheus/kustomization.yaml` - rewrite
- `apps/production/monitoring/grafana/kustomization.yaml` - rewrite

### Existing files to keep (move/copy):
- `apps/production/monitoring/namespace.yaml`
- `apps/production/monitoring/prometheus/certificate.yaml`
- `apps/production/monitoring/grafana/certificate.yaml`
- `apps/production/monitoring/prometheus/config/web.yaml` (move up one level)
- `apps/production/monitoring/prometheus/.env.secret.prometheus-self-scrape.encrypted`
- `apps/production/monitoring/prometheus-alertmanager/.env.secret.alertmanager.encrypted` (move to prometheus/)

### Existing files/dirs to delete:
- `apps/production/monitoring/prometheus/config/` (entire directory - configs move into HelmRelease values)
- `apps/production/monitoring/prometheus/prometheus-statefulset.yaml`
- `apps/production/monitoring/prometheus/authorize-prometheus-to-k8s.yaml`
- `apps/production/monitoring/prometheus-alertmanager/` (entire directory)
- `apps/production/monitoring/prometheus-blackbox-exporter/` (entire directory)
- `apps/production/monitoring/kube-state-metrics/` (entire directory)
- `apps/production/monitoring/grafana/grafana-statefulset.yaml`
- `apps/base/monitoring/kube-state-metrics/` (entire directory)

### App source files:
- `/Users/scott/src/activescott/gpu-poet` - ~30 files for pino migration
- `/Users/scott/src/activescott/ramblefeed/packages/web-app` - add logger module + middleware
- `/Users/scott/src/tayle-co/tayle/apps/app/package.json` - remove pino-pretty from start
- `/Users/scott/src/tayle-co/tayle/apps/worker/package.json` - remove pino-pretty from start

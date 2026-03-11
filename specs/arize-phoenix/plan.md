# Plan: Self-host Arize Phoenix

## Context

Deploy Arize Phoenix (LLM observability platform) to the nas1 Kubernetes cluster via Flux GitOps. Phoenix collects OpenTelemetry traces from LLM applications, providing a UI for analyzing LLM calls, evaluations, and experiments. This will be the cluster's first distributed tracing tool.

Phoenix publishes a kustomize base at `https://github.com/Arize-ai/phoenix//kustomize/base?ref=arize-phoenix-v12.35.0` containing a Phoenix StatefulSet and a PostgreSQL StatefulSet. We'll reference this remote base and apply production overlays following existing repo patterns.

**Decisions:**
- Hostname: `phoenix.activescott.com`
- Auth: Enabled (PHOENIX_ENABLE_AUTH, PHOENIX_SECRET, admin account)
- Storage: `/mnt/thedatapool/app-data/arize-phoenix/db-data` (backed up)
- Telemetry: Disabled (PHOENIX_TELEMETRY_ENABLED=false)
- Tag: `arize-phoenix-v12.35.0` (pinned)

## Files to Create

All under `apps/production/arize-phoenix/`:

### 1. `namespace.yaml`
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: arize-phoenix
```

### 2. `kustomization.yaml`
References the remote Phoenix kustomize base at a pinned git tag, applies all production overlays.

```yaml
resources:
  - namespace.yaml
  - db-pv.yaml
  - app-ingress.yaml
  - app-ingress-certificate.yaml
  - https://github.com/Arize-ai/phoenix//kustomize/base?ref=arize-phoenix-v12.35.0
patches:
  - path: patch-phoenix-statefulset.yaml
    target:
      kind: StatefulSet
      name: phoenix
  - path: patch-postgres-statefulset.yaml
    target:
      kind: StatefulSet
      name: postgres
namespace: arize-phoenix
secretGenerator:
  - name: phoenix-creds
    envs:
      - .env.secret.phoenix.encrypted
  - name: db-creds
    envs:
      - .env.secret.db.encrypted
```

### 3. `db-pv.yaml`
PersistentVolume for Postgres data on backed-up storage.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: arize-phoenix-db-pv-data
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-path
  hostPath:
    path: /mnt/thedatapool/app-data/arize-phoenix/db-data
```

### 4. `app-ingress.yaml`
Ingress for the Phoenix web UI and OTLP HTTP endpoint.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: phoenix-ingress
spec:
  tls:
    - hosts:
        - phoenix.activescott.com
      secretName: phoenix-activescott-com-tls
  rules:
    - host: phoenix.activescott.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: phoenix
                port:
                  number: 6006
```

### 5. `app-ingress-certificate.yaml`
cert-manager Certificate for TLS (pattern from `apps/production/gpupoet/app-ingress-certificate.yaml`).

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: phoenix-activescott-com-tls
  namespace: arize-phoenix
spec:
  secretName: phoenix-activescott-com-tls
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
  dnsNames:
    - phoenix.activescott.com
```

### 6. `patch-phoenix-statefulset.yaml`
JSON patch on the upstream Phoenix StatefulSet to:
- Add env vars from `phoenix-creds` secret (envFrom)
- Add configuration env vars (auth, telemetry, CSRF origins)
- Set `PHOENIX_ENABLE_PROMETHEUS=true`

```yaml
- op: add
  path: /spec/template/spec/containers/0/envFrom
  value:
    - secretRef:
        name: phoenix-creds
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: PHOENIX_ENABLE_AUTH
    value: "True"
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: PHOENIX_TELEMETRY_ENABLED
    value: "false"
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: PHOENIX_ENABLE_PROMETHEUS
    value: "true"
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: PHOENIX_CSRF_TRUSTED_ORIGINS
    value: "https://phoenix.activescott.com"
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: PHOENIX_ROOT_URL
    value: "https://phoenix.activescott.com"
```

### 7. `patch-postgres-statefulset.yaml`
Patch to:
- Replace default Postgres credentials with secret references from `db-creds`
- Bind the PVC to the pre-created PV

```yaml
- op: replace
  path: /spec/volumeClaimTemplates/0/spec/volumeName
  value: arize-phoenix-db-pv-data
- op: add
  path: /spec/template/spec/containers/0/envFrom
  value:
    - secretRef:
        name: db-creds
```

Note: The upstream postgres.yaml hardcodes credentials as plain env vars (`POSTGRES_PASSWORD: postgres123`). The patch will add envFrom to inject from the secret. We'll also need to remove/override the hardcoded values. The exact patch operations will need to match the upstream manifest structure (will verify during implementation by reading the fetched upstream YAML).

### 8. `.env.secret.phoenix` (plaintext, to be encrypted)
```
PHOENIX_SECRET=<generate-32-char-random-string>
PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD=<user-chosen-password>
```

### 9. `.env.secret.db` (plaintext, to be encrypted)
```
POSTGRES_PASSWORD=<generate-strong-password>
POSTGRES_USER=postgres
POSTGRES_DB=phoenix
PGUSER=postgres
```

These will be encrypted with SOPS/age to `.env.secret.phoenix.encrypted` and `.env.secret.db.encrypted`.

### 10. `README.md`
Comprehensive documentation covering:
- What Phoenix is and what it does
- Architecture (Phoenix + Postgres, ports 6006/4317/9090)
- How to set up credentials (create .env.secret files, encrypt with SOPS)
- DNS setup (point phoenix.activescott.com to cluster)
- TLS certificate (auto-provisioned by cert-manager)
- Initial login (admin@localhost + configured password)
- Creating API keys for trace collection
- How to upgrade the Phoenix version (change git tag in kustomization.yaml)
- How to configure TypeScript apps (like tinkerbell) to send traces:
  - Install `@arizeai/phoenix-otel` npm package
  - Set `PHOENIX_COLLECTOR_ENDPOINT` env var to `http://phoenix.arize-phoenix.svc.cluster.local:6006`
  - Set `PHOENIX_API_KEY` env var with an API key from Phoenix
  - Call `register({ projectName: "app-name" })` in app startup
- For in-cluster apps: use the cluster-internal service URL
- For external apps: use `https://phoenix.activescott.com`

## File to Modify

### `apps/production/kustomization.yaml`
Add `- ./arize-phoenix` to the resources list.

## Key Design Decisions

1. **Remote kustomize base**: Reference upstream directly with pinned tag rather than copying manifests locally. To upgrade, change the `?ref=` tag.

2. **No local base directory**: Unlike other apps that have `apps/base/<app>/`, Phoenix uses the upstream repo as its base. No `apps/base/arize-phoenix/` needed.

3. **Postgres credentials via secret overlay**: The upstream hardcodes `postgres123`. We override with SOPS-encrypted secrets via envFrom patch + secretGenerator.

4. **Phoenix SQL connection string**: The upstream Phoenix StatefulSet sets `PHOENIX_SQL_DATABASE_URL` pointing to `postgres` service. Since kustomize applies our `namespace: arize-phoenix`, the service name resolution will work within the namespace.

5. **Phoenix OTLP via Ingress**: The HTTP OTLP endpoint shares port 6006 with the UI (at `/v1/traces`), so it's automatically available via ingress. The gRPC endpoint (4317) is only available cluster-internally via the Service.

6. **In-cluster service URL**: Apps in the cluster reach Phoenix at `http://phoenix.arize-phoenix.svc.cluster.local:6006` (HTTP) or `phoenix.arize-phoenix.svc.cluster.local:4317` (gRPC).

## Verification

1. **Flux reconciliation**: After committing, verify Flux picks it up:
   ```bash
   kubectl --context nas get kustomization -n flux-system apps
   ```
2. **Namespace and pods**:
   ```bash
   kubectl --context nas get pods -n arize-phoenix
   ```
3. **Certificate issued**:
   ```bash
   kubectl --context nas get certificate -n arize-phoenix
   ```
4. **Web UI**: Visit `https://phoenix.activescott.com` and log in as `admin@localhost`
5. **Create API key**: In Phoenix UI, go to Settings > API Keys, create a system key
6. **Test trace ingestion** (from a cluster pod or port-forward):
   ```bash
   curl -X POST http://phoenix.arize-phoenix.svc.cluster.local:6006/v1/traces \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <api-key>"
   ```
7. **Grafana MCP**: Use `mcp__grafana__query_prometheus` to check Phoenix metrics if Prometheus is scraping it

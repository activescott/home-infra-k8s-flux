# Arize Phoenix

[Arize Phoenix](https://github.com/Arize-ai/phoenix) is an open-source LLM observability platform. It collects OpenTelemetry traces from LLM applications and provides a web UI for analyzing LLM calls, evaluations, and experiments.

## Architecture

- **Phoenix** (StatefulSet): Web UI on port 6006, OTLP HTTP on port 6006 (`/v1/traces`), OTLP gRPC on port 4317, Prometheus metrics on port 9090
- **PostgreSQL** (StatefulSet): Backing database on port 5432, data stored at `/mnt/thedatapool/app-data/arize-phoenix/db-data`

The deployment uses the upstream kustomize base from `github.com/Arize-ai/phoenix/kustomize/base` at a pinned git tag, with production overlays applied via JSON patches.

## Setup

### 1. Create secrets

Edit the placeholder files and fill in real values:

```bash
# Phoenix secrets
vi apps/production/arize-phoenix/.env.secret.phoenix
# Set: PHOENIX_SECRET (32+ random chars), PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD, PHOENIX_SQL_DATABASE_URL

# Database secrets
vi apps/production/arize-phoenix/.env.secret.db
# Set: POSTGRES_PASSWORD (must match the password in PHOENIX_SQL_DATABASE_URL)
```

Encrypt with SOPS:

```bash
sops --encrypt --age age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt \
  apps/production/arize-phoenix/.env.secret.phoenix > apps/production/arize-phoenix/.env.secret.phoenix.encrypted

sops --encrypt --age age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt \
  apps/production/arize-phoenix/.env.secret.db > apps/production/arize-phoenix/.env.secret.db.encrypted
```

### 2. DNS

Point `phoenix.activescott.com` to the cluster ingress IP.

### 3. Deploy

Commit and push. Flux will reconcile automatically. The TLS certificate is auto-provisioned by cert-manager via the `letsencrypt-production` ClusterIssuer.

### 4. Initial login

Visit `https://phoenix.activescott.com` and log in with:
- Email: `admin@localhost`
- Password: the value you set for `PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD`

### 5. Create API keys

In the Phoenix UI, go to Settings > API Keys and create a system key for trace collection.

## Sending Traces

### In-cluster apps

Use the cluster-internal service URL:
- HTTP: `http://phoenix.arize-phoenix.svc.cluster.local:6006`
- gRPC: `phoenix.arize-phoenix.svc.cluster.local:4317`

### External apps

Use: `https://phoenix.activescott.com`

### TypeScript/Node.js example

```bash
npm install @arizeai/phoenix-otel
```

```typescript
import { register } from "@arizeai/phoenix-otel";

register({
  projectName: "my-app",
  endpoint: "http://phoenix.arize-phoenix.svc.cluster.local:6006",
  headers: { Authorization: "Bearer <api-key>" },
});
```

Set environment variables:
- `PHOENIX_COLLECTOR_ENDPOINT=http://phoenix.arize-phoenix.svc.cluster.local:6006`
- `PHOENIX_API_KEY=<api-key-from-phoenix-ui>`

## Upgrading

Change the git tag in `kustomization.yaml`:

```yaml
resources:
  - https://github.com/Arize-ai/phoenix//kustomize/base?ref=arize-phoenix-v<NEW_VERSION>
```

## Verification

```bash
# Check Flux reconciliation
kubectl --context nas get kustomization -n flux-system apps

# Check pods
kubectl --context nas get pods -n arize-phoenix

# Check certificate
kubectl --context nas get certificate -n arize-phoenix

# Check logs
kubectl --context nas logs -n arize-phoenix statefulset/phoenix
```

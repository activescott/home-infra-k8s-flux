# Arize Phoenix - Implementation Summary

## What was done

Deployed Arize Phoenix LLM observability platform to the nas1 cluster via Flux GitOps.

## Files created

All under `apps/production/arize-phoenix/`:

| File | Purpose |
|------|---------|
| `namespace.yaml` | `arize-phoenix` namespace |
| `kustomization.yaml` | Kustomize overlay referencing upstream base at `arize-phoenix-v12.35.0` |
| `db-pv.yaml` | PersistentVolume on `/mnt/thedatapool/app-data/arize-phoenix/db-data` |
| `phoenix-service.yaml` | ClusterIP Service for Phoenix (ports 6006, 4317, 9090) - **not in upstream** |
| `app-ingress.yaml` | Ingress for `phoenix.activescott.com` -> phoenix:6006 |
| `app-ingress-certificate.yaml` | cert-manager Certificate via letsencrypt-production ClusterIssuer |
| `patch-phoenix-statefulset.yaml` | JSON patch: removes hardcoded DB URL, adds envFrom + auth/telemetry/CSRF config |
| `patch-postgres-statefulset.yaml` | JSON patch: removes hardcoded creds, adds envFrom + binds PVC to PV |
| `.env.secret.phoenix` | Placeholder secrets (PHOENIX_SECRET, admin password, DB URL) |
| `.env.secret.db` | Placeholder secrets (POSTGRES_PASSWORD, user, db name) |
| `README.md` | Setup, usage, and upgrade documentation |

## Files modified

| File | Change |
|------|--------|
| `apps/production/kustomization.yaml` | Added `- ./arize-phoenix` to resources |

## Deviations from plan

1. **Added `phoenix-service.yaml`**: The upstream kustomize base does not include a Service for the Phoenix StatefulSet (only Postgres has one). A ClusterIP Service was added to expose ports 6006 (HTTP/OTLP), 4317 (gRPC), and 9090 (metrics). Required for Ingress to work.

2. **Moved `PHOENIX_SQL_DATABASE_URL` to secret**: The upstream hardcodes the DB connection string with `postgres123`. Since K8s `env` takes precedence over `envFrom`, the hardcoded entry is removed via JSON patch and the connection URL is provided through the `phoenix-creds` secret instead.

3. **Removed hardcoded Postgres credentials via patch**: The upstream hardcodes `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB`, and `PGUSER` as plain env vars. These are removed (indices 4, 2, 1, 0 in reverse order) and replaced via `envFrom` from the `db-creds` secret.

4. **Fixed database name**: Upstream has a mismatch (`POSTGRES_DB=postgresdb` but Phoenix connects to `postgres`). We use `phoenix` consistently in both the DB secret and connection URL.

5. **Secrets left as placeholders**: User will fill in actual values and encrypt with SOPS before deploying.

## Remaining steps for user

1. Fill in real values in `.env.secret.phoenix` and `.env.secret.db`
2. Encrypt both with SOPS/age to create `.encrypted` files
3. Set up DNS for `phoenix.activescott.com`
4. Commit and push to trigger Flux reconciliation
5. Create the host directory: `mkdir -p /mnt/thedatapool/app-data/arize-phoenix/db-data`

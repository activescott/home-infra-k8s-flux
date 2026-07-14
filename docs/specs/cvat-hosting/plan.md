# CVAT hosting on nas1 (implementation plan)

Origin spec: `steward` repo `docs/specs/cvat-home-infra-hosting/plan.md`. This file is the
home-infra-side implementation plan.

## Decisions (confirmed with Scott 2026-07-13)

- **Hostname:** `cvat.activescott.com`, public ingress + TLS via `letsencrypt-production`
  ClusterIssuer (HTTP-01), same as arize-phoenix.
- **Approach (REVISED 2026-07-14):** the upstream CVAT Helm chart via Flux
  `HelmRelease`, built from the CVAT git repo at the pinned tag (chart isn't published
  to a registry); Bitnami postgres/redis subcharts disabled, with our own postgres/
  redis/kvrocks wired in as the chart's "external" services. The first iteration was
  hand-rolled kustomize; it hit three boot failures in one evening (kvrocks config
  shadowed by the data mount, unset `SMOKESCREEN_OPTS`, unset
  `CVAT_REDIS_INMEM_PASSWORD` — all env/volume contracts the chart's templates encode)
  plus a `--with-scheduler` flag that didn't exist in v2.44.3, and Scott chose the
  chart as easier to maintain long-term.
- **Version:** `cvat/server:v2.44.3` + `cvat/ui:v2.44.3` — matches the local
  Docker-Compose instance being migrated from (`/Users/scott/src/cvat-ai/cvat` checkout).
- **Storage (hostPath, cluster runs on the NAS):**
  - `/mnt/thedatapool/photos/steward/cvat` → `/home/django/data` (CVAT's media/data
    volume: uploaded images, chunk cache, tmp)
  - `/mnt/thedatapool/photos/steward/originals` → `/home/django/share/originals`
    (read-only "connected file share"; Scott writes original captures here via SMB/NFS
    from the Mac, then imports into CVAT tasks from the share)
  - `/mnt/thedatapool/app-data/cvat/{db-data,keys,logs,redis-inmem-data,kvrocks-data}`
    for internals (postgres, Django keys, logs, redis AOF, kvrocks)
- **Analytics disabled:** no clickhouse/vector/grafana; `CVAT_ANALYTICS=0`.
- **Consensus worker skipped** (feature unused); all other workers deployed. The
  connected share is mounted on the server AND every worker — the local compose
  deployment proved chunks are built lazily by the chunks worker and 500 without it.

## Workloads (namespace `cvat`)

| component | image | kind | notes |
|---|---|---|---|
| cvat-db | postgres:15-alpine | StatefulSet | POSTGRES_USER=root, DB=cvat, password from secret |
| cvat-redis-inmem | redis:7.2.11-alpine | StatefulSet | `--save 60 100 --appendonly yes` |
| cvat-redis-ondisk | apache/kvrocks:2.15.0 | StatefulSet | port 6666, runs as uid 999 |
| cvat-opa | openpolicyagent/opa:1.12.2 | Deployment | bundle polled from `http://cvat-server:8080/api/auth/rules` |
| cvat-server | cvat/server:v2.44.3 | Deployment | args `init run server nginx`; runs migrations |
| cvat-worker-{utils,import,export,annotation,webhooks,quality-reports,chunks} | cvat/server:v2.44.3 | Deployment | `run worker <name>` each |
| cvat-ui | cvat/ui:v2.44.3 | Deployment | port 8000 |

Shared backend env in ConfigMap `cvat-backend-config` (`envFrom` on server + workers):
`CVAT_POSTGRES_HOST=cvat-db`, `CVAT_REDIS_INMEM_HOST=cvat-redis-inmem`,
`CVAT_REDIS_ONDISK_HOST=cvat-redis-ondisk` (port 6666), `CVAT_OPA_URL=http://cvat-opa:8181`,
`ALLOWED_HOSTS=cvat.activescott.com`, `CVAT_BASE_URL=https://cvat.activescott.com`,
`CVAT_NUM_PROXIES=1`, `CVAT_ANALYTICS=0`. Postgres password comes from the SOPS secret
(both `POSTGRES_PASSWORD` for the db pod and `CVAT_POSTGRES_PASSWORD` for backends).

Django proxy handling is already correct upstream (`SECURE_PROXY_SSL_HEADER` +
`USE_X_FORWARDED_HOST` in cvat settings/base.py), so TLS termination at the ingress works.

## Routing

Single Ingress on `cvat.activescott.com` mirroring the compose traefik rules:
`/api`, `/static`, `/admin`, `/django-rq` → `cvat-server:8080`; `/` → `cvat-ui:8000`.
Certificate resource `cvat-activescott-com-tls`, issuer `letsencrypt-production`.

## Secrets

One SOPS-encrypted dotenv: `apps/production/cvat/.env.secret.cvat` (gitignored) →
`.env.secret.cvat.encrypted` (committed) via `./scripts/encrypt-env-files.sh
apps/production/cvat`. Keys: `POSTGRES_PASSWORD` and `CVAT_POSTGRES_PASSWORD` (same
value). CVAT superuser is NOT in the secret — created once via `kubectl exec ...
manage.py createsuperuser` after first boot; Django's own secret keys are generated on
first boot into the persisted `keys/` volume.

## Steward-repo follow-ups (separate repo)

- Env-var fallbacks `STEWARD_CVAT_URL` / `STEWARD_CVAT_USER` / `STEWARD_CVAT_PASSWORD`
  (or token) in check_labels/sync_deleted/prelabel.
- Migration: export local task 1 as "CVAT for Images 1.1", recreate project + labels +
  guide on the new instance, re-import, verify with steward-check-labels.

## Sequencing

1. Write manifests + docs (this repo), stage for review.
2. Scott: create NAS directories + ownership (commands in `summary.md`).
3. Scott: generate postgres password → `.env.secret.cvat` → run encrypt script; save
   plaintext to 1Password.
4. Scott: add DNS record `cvat.activescott.com` → same public IP as
   `phoenix.activescott.com`.
5. Commit + push; Flux deploys; watch `kubectl --context nas get pods -n cvat`.
6. Create superuser + per-person accounts; migrate task 1 from the laptop.

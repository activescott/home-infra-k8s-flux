# CVAT

[CVAT](https://github.com/cvat-ai/cvat) is an image/video annotation tool. This instance
serves the steward project's labeling (blackberry stem detection); the steward repo's
tooling talks to it over the REST API at `https://cvat.activescott.com`.

Design/decisions: `docs/specs/cvat-hosting/plan.md`. Server-side setup commands
(NAS directories, permissions, secrets): `docs/specs/cvat-hosting/summary.md`.

## Architecture

Hand-rolled manifests mirroring upstream `docker-compose.yml` at `v2.44.3` (no Helm —
the CVAT chart depends on banned Bitnami charts). Namespace `cvat`:

- **cvat-server** (`cvat/server:v2.44.3`): Django + nginx on 8080; `init` runs migrations
- **cvat-worker-{utils,import,export,annotation,webhooks,quality-reports,chunks}**: RQ
  workers, same image. The consensus worker is intentionally omitted (feature unused).
- **cvat-ui** (`cvat/ui:v2.44.3`): static frontend on 8000
- **cvat-opa**: authorization; polls its bundle from cvat-server
- **cvat-db** (postgres:15-alpine), **cvat-redis-inmem** (redis 7), **cvat-redis-ondisk**
  (kvrocks; chunk cache)
- Analytics stack (clickhouse/vector/grafana) not deployed; `CVAT_ANALYTICS=0`.

Ingress routes `/api|/static|/admin|/django-rq` → server, `/` → ui, TLS via
cert-manager (`letsencrypt-production`).

## Storage (hostPath)

| host path                                         | mounted at                             | what                                           |
| ------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `/mnt/thedatapool/photos/steward/cvat`            | `/home/django/data` (server + workers) | CVAT media: uploads, chunk cache               |
| `/mnt/thedatapool/photos/steward/originals`       | `/home/django/share/originals` (ro)    | connected file share; Mac writes captures here |
| `/mnt/thedatapool/app-data/cvat/db-data`          | postgres data                          |                                                |
| `/mnt/thedatapool/app-data/cvat/keys`             | `/home/django/keys`                    | Django secret keys, generated on first boot    |
| `/mnt/thedatapool/app-data/cvat/logs`             | `/home/django/logs`                    |                                                |
| `/mnt/thedatapool/app-data/cvat/redis-inmem-data` | redis AOF                              |                                                |
| `/mnt/thedatapool/app-data/cvat/kvrocks-data`     | kvrocks                                | needs uid/gid 999                              |

**Gotcha carried over from the local compose deployment:** the share must be mounted on
the server AND every media worker. Chunks are built lazily by `cvat-worker-chunks`; if it
lacks the mount, frames past the first chunk 500 with FileNotFoundError.

## Secrets

`.env.secret.cvat` (gitignored, plaintext in 1Password) → encrypt with
`./scripts/encrypt-env-files.sh apps/production/cvat` → commit only the `.encrypted`
file. Holds the postgres password (as both `POSTGRES_PASSWORD` and
`CVAT_POSTGRES_PASSWORD`).

The CVAT superuser is not in any secret. Create once after first boot:

```sh
kubectl --context nas -n cvat exec -it deploy/cvat-server -- python3 ~/manage.py createsuperuser
```

Then create per-person accounts and API tokens in the UI/API; steward tooling should use
token auth, never the superuser.

## Verification

```sh
kubectl --context nas get pods -n cvat
kubectl --context nas get certificate -n cvat
kubectl --context nas logs -n cvat deploy/cvat-server
curl -s https://cvat.activescott.com/api/server/about
```

## Upgrading

Bump the `cvat/server` and `cvat/ui` tags together (all 9 workloads use the same two
images). Check upstream release notes; `init` on cvat-server runs migrations
automatically. `strategy: Recreate` on the server prevents two migrators racing.

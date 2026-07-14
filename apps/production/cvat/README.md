# CVAT

[CVAT](https://github.com/cvat-ai/cvat) is an image/video annotation tool. This instance
serves the steward project's labeling (blackberry stem detection); the steward repo's
tooling talks to it over the REST API at `https://cvat.activescott.com`.

Design/decisions: `docs/specs/cvat-hosting/plan.md`. Server-side setup commands
(NAS directories, permissions, secrets): `docs/specs/cvat-hosting/summary.md`.

## Architecture

The upstream [CVAT Helm chart](https://docs.cvat.ai/docs/administration/community/advanced/k8s_deployment_with_helm/)
via Flux `HelmRelease`, built from the CVAT git repo at tag `v2.44.3` (`helm.yaml` —
the chart isn't published to a registry). The chart deploys the server, 8 workers,
frontend, opa, the migrations initializer job, and the ingress.

The chart's bundled Bitnami postgres/redis subcharts are **disabled** (banned — see
root README "Image source rule"). This app provides its own and wires them in as the
chart's "external" services:

- `db.yaml` — postgres:15-alpine (`cvat-db`)
- `redis-inmem.yaml` — redis 7 (`cvat-redis-inmem`)
- `redis-ondisk.yaml` — apache/kvrocks chunk cache (`cvat-redis-ondisk`); data lives in
  a SUBDIR of /var/lib/kvrocks because the image bakes its config into that dir and a
  mount there would shadow it
- Analytics (clickhouse/vector/grafana) and nuclio (serverless) disabled.

## Storage (hostPath)

| host path                                         | what                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/mnt/thedatapool/photos/steward/cvat`            | chart's `cvat-backend-data` PVC via static PV (`backend-data-pv.yaml`): `data/`, `keys/`, `logs/` subPaths            |
| `/mnt/thedatapool/photos/steward/originals`       | connected file share, mounted ro at `/home/django/share/originals` on server + ALL workers (`additionalVolumeMounts`) |
| `/mnt/thedatapool/app-data/cvat/db-data`          | postgres data                                                                                                         |
| `/mnt/thedatapool/app-data/cvat/redis-inmem-data` | redis AOF                                                                                                             |
| `/mnt/thedatapool/app-data/cvat/kvrocks-data`     | kvrocks chunk cache                                                                                                   |

**Gotcha (learned locally on compose):** the originals share must be mounted on the
server AND every media worker — chunks are built lazily by the chunks worker; without
the mount, frames past the first chunk 500 with FileNotFoundError.

**permissionFix disabled:** the chart's `permissionFix` init container (`chmod -R 777`
over `/home/django` on every backend pod start) is turned off in `helm.yaml` — it
crashes on the read-only originals share mounted under that tree, and a recursive chmod
would degrade pod starts as the chunk cache grows (the same lesson as photoprism's
`PHOTOPRISM_DISABLE_CHOWN`). Consequence: `data/`, `keys/`, `logs/` under the PV path
must stay writable by uid 1000 — "permission denied" in backend logs means fix
ownership on the NAS, not re-enable the chmod.

## Secrets

- `cvat-postgres-secret` (SOPS, `.env.secret.cvat-postgres` → `.encrypted`, plaintext in
  1Password): keys `username`/`database`/`password`, consumed by both the postgres pod
  and the chart's backends. Re-encrypt with `./scripts/encrypt-env-files.sh
apps/production/cvat`.
- `cvat-cache-auth` (plain yaml, not secret): empty `password` for the chart's
  redis/kvrocks env refs — both run without auth, cluster-internal only.
- CVAT superuser: created once after first boot (server pod name differs under the
  chart):

```sh
kubectl --context nas -n cvat exec -it deploy/cvat-backend-server -- python3 /home/django/manage.py createsuperuser
```

Then create per-person accounts and API tokens in the UI; steward tooling uses those,
never the superuser.

## Verification

```sh
kubectl --context nas get helmrelease -n cvat
kubectl --context nas get pods -n cvat
kubectl --context nas get certificate -n cvat
curl -s https://cvat.activescott.com/api/server/about
```

## Upgrading

Bump the `tag:` in `helm.yaml`'s GitRepository (chart + app versions move together in
the CVAT repo). The initializer job re-runs migrations on upgrade. Check the release
notes and the chart's values diff (`git -C <cvat checkout> diff vOLD..vNEW -- helm-chart`).

## References

- Official k8s/Helm deployment guide: <https://docs.cvat.ai/docs/administration/community/advanced/k8s_deployment_with_helm/>
- Chart source (lives inside the CVAT repo, not a chart registry): <https://github.com/cvat-ai/cvat/tree/develop/helm-chart>
- Versions + release notes: <https://github.com/cvat-ai/cvat/releases>
- Chart default values (at our pinned tag): <https://github.com/cvat-ai/cvat/blob/v2.44.3/helm-chart/values.yaml>

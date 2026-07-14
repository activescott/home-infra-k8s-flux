# CVAT hosting — summary / runbook

Status 2026-07-14: DEPLOYED AND HEALTHY on the upstream Helm chart — HelmRelease
UpgradeSucceeded (chart 0.15.1 @ v2.44.3), 17/17 pods Running, certificate issued,
`https://cvat.activescott.com/api/server/about` serving over TLS. Superuser created;
Scott logged in. Remaining: per-person accounts + a steward tooling account (step 5),
then task-1 migration from the laptop (step 6).

Background: switched from hand-rolled manifests (Scott's call — easier to maintain;
the hand-rolled iteration burned an evening rediscovering env/volume contracts the
chart encodes). `apps/production/cvat/` = HelmRelease (server, workers, ui, opa,
ingress, migrations job) + our own postgres/redis/kvrocks as the chart's "external"
services + static PV + certificate. NAS dirs, password, and DNS carried over from the
first iteration; secret file renamed `.env.secret.cvat` → `.env.secret.cvat-postgres`
(chart-shaped keys username/database/password, same password value, re-encrypted).
Chart-era gotchas hit during rollout: permissionFix chmod vs the read-only share
(disabled — see README), and a failed helm install retries with the values snapshot
from when the attempt started, so a values fix can take one extra 15m install cycle
to land.

Steps 1-3 below are DONE (kept for the record / rebuild-from-scratch case).

## 1. Directories to create on the NAS (run as root on nas1)

Container UIDs differ per image, so ownership matters (hostPath volumes are NOT
chown'd by kubernetes — fsGroup does not apply to hostPath):

- cvat server/workers run as uid/gid **1000** (`django`)
- kvrocks runs as uid/gid **999**
- postgres and redis entrypoints start as root and chown their own data dirs — leave
  those root-owned

```sh
# app internals
mkdir -p /mnt/thedatapool/app-data/cvat/db-data \
         /mnt/thedatapool/app-data/cvat/keys \
         /mnt/thedatapool/app-data/cvat/logs \
         /mnt/thedatapool/app-data/cvat/redis-inmem-data \
         /mnt/thedatapool/app-data/cvat/kvrocks-data
chown 1000:1000 /mnt/thedatapool/app-data/cvat/keys /mnt/thedatapool/app-data/cvat/logs
chown 999:999 /mnt/thedatapool/app-data/cvat/kvrocks-data

# steward media: CVAT's own data volume (rw, uid 1000) and the originals share (ro)
mkdir -p /mnt/thedatapool/photos/steward/cvat \
         /mnt/thedatapool/photos/steward/originals
chown 1000:1000 /mnt/thedatapool/photos/steward/cvat
chmod 770 /mnt/thedatapool/photos/steward/cvat

# originals is written by user scott (rsync/SMB) and only READ by CVAT (uid 1000).
# scott owns it; world-readable so uid 1000 can read. Files rsync'd with default
# umask 022 land 644/755 — fine. Do NOT rsync with -p/-a from a source with 600
# perms or CVAT loses read; -rtv is right. If CVAT can't see new files in the
# share, ownership/umask here is the first thing to check.
chown -R scott /mnt/thedatapool/photos/steward/originals
chmod -R a+rX /mnt/thedatapool/photos/steward/originals
```

## 2. Secrets

Only ONE secret file: `apps/production/cvat/.env.secret.cvat-postgres` (gitignored;
only `.encrypted` is committed; plaintext in 1Password). Keys match the CVAT helm
chart's postgres-secret contract and double as the postgres container's init config:

- `username=root`, `database=cvat`, `password=<generated>`

To rotate/recreate (NOTE: postgres bakes the password into its data dir on first
init — changing it after that means manual `ALTER USER` inside postgres):

```sh
cd ~/src/activescott/home-infra-k8s-flux
# edit apps/production/cvat/.env.secret.cvat-postgres, then:
./scripts/encrypt-env-files.sh apps/production/cvat
git add apps/production/cvat/.env.secret.cvat-postgres.encrypted
```

NOT in any .env: the CVAT superuser (created interactively post-boot, step 5) and
Django's secret keys (self-generated on first boot into the persisted `keys/` subdir
of the backend-data PV).

## 3. DNS

Add `cvat.activescott.com` → same public IP/CNAME target as `phoenix.activescott.com`.
Required before the cert issues (HTTP-01) and before the UI works.

## 4. Deploy + watch

Push to main; the GitHub webhook triggers Flux (no manual `flux reconcile`).

```sh
kubectl --context nas get helmrelease -n cvat
kubectl --context nas get pods -n cvat -w
kubectl --context nas get certificate -n cvat
kubectl --context nas logs -n cvat deploy/cvat-backend-server -f
curl -s https://cvat.activescott.com/api/server/about
```

First install is slow: the GitRepository clones the whole CVAT repo, the chart build
downloads 7 subchart tarballs, and the initializer job runs all Django migrations.
A failed helm install/upgrade retries with a 15m timeout per attempt — and each
attempt uses the values snapshot from when it STARTED, so a values fix can take one
extra full cycle to land.

## 5. First-boot accounts

```sh
kubectl --context nas -n cvat exec -it deploy/cvat-backend-server -- python3 /home/django/manage.py createsuperuser
```

Then in the UI: create per-person accounts; create an API token for steward tooling
(token auth, not the superuser password).

## 6. Migration from laptop CVAT (steward repo side)

Per `steward/docs/specs/cvat-home-infra-hosting/plan.md`: export local task 1 as
"CVAT for Images 1.1" snapshot, recreate project `blackberry-stem` + labels + guide
(`labeling/label-schema.md`, `POST /api/guides`), load images, import annotations,
verify with `steward-check-labels` against the new URL.

## Gotchas / non-obvious

- **Share on every worker:** the originals share is mounted on the server AND every
  worker via `cvat.backend.additionalVolumeMounts` (chart applies it backend-wide).
  Chunks are built lazily by the chunks worker; missing mount there = 500 /
  FileNotFoundError on frames past the first chunk. Learned the hard way on the local
  compose setup (`steward/labeling/docker-compose.override.yml`).
- **hostPath/PV ownership:** kubernetes never chowns hostPath volumes, and the chart's
  `permissionFix` chmod is disabled (it dies on the read-only share and would slow pod
  starts as the cache grows). "permission denied" in backend logs → fix ownership on
  the NAS (`data/`, `keys/`, `logs/` under the PV path must be writable by uid 1000).
- **Bitnami subcharts disabled, but still DOWNLOADED:** the chart build fetches all 7
  subchart tarballs (3 from charts.bitnami.com) even though they're disabled. If the
  legacy Bitnami chart repo ever goes away, the chart build breaks — the fix would be
  vendoring the chart or stripping deps in a fork.
- **Old hand-rolled iteration:** first deployment was hand-rolled manifests (git
  history around 06bdaab..311156e, 2026-07-13); switched to the chart after repeated
  env/volume contract bugs. `db.yaml`/`redis-inmem.yaml`/`redis-ondisk.yaml` survive
  from it as the chart's external services.
- **Validation:** `kubectl kustomize apps/production/cvat | kubectl --context nas apply
  --dry-run=client --validate=true -f -`. Server-side dry-run reports "namespaces cvat
  not found" for every object until the namespace actually exists — not an error in the
  manifests. The HelmRelease values can be render-tested locally: worktree the CVAT
  repo at the pinned tag, copy it WITHOUT symlinks (mirrors Flux's artifact), `helm
  dependency build`, `helm template` with the values from `helm.yaml`.

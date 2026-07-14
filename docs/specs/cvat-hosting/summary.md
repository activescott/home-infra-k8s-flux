# CVAT hosting — summary / runbook

Status 2026-07-13: manifests written and staged (not committed). Validated with
`kubectl kustomize apps/production` and client-side `kubectl apply --dry-run`.
Remaining steps below are Scott's (NAS dirs, real password, DNS), then push.

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

# originals is written from the Mac over SMB/NFS and only READ by CVAT (uid 1000).
# Simplest: make the tree world-readable; check that files created later via SMB
# inherit readable permissions (TrueNAS dataset ACL/aclmode) — if CVAT can't see new
# files in the share, this is the first thing to check.
chmod -R a+rX /mnt/thedatapool/photos/steward/originals
```

## 2. Secrets

Only ONE secret file, already created as a placeholder (CHANGEME) at
`apps/production/cvat/.env.secret.cvat` (gitignored; only `.encrypted` is committed):

- `POSTGRES_PASSWORD` — initializes the postgres container
- `CVAT_POSTGRES_PASSWORD` — what Django connects with; MUST be the same value

Steps (do BEFORE the first push — postgres initializes its data dir with whatever
password ships first, and changing it afterward means manual `ALTER USER`):

```sh
cd ~/src/activescott/home-infra-k8s-flux
# 1. generate + insert password (both lines get the same value):
pw=$(openssl rand -base64 24)
sed -i '' "s|CHANGEME|$pw|g" apps/production/cvat/.env.secret.cvat
# 2. save the plaintext file's contents to 1Password (repo convention)
# 3. re-encrypt (overwrites the placeholder .encrypted that was staged):
./scripts/encrypt-env-files.sh apps/production/cvat
git add apps/production/cvat/.env.secret.cvat.encrypted
```

NOT in any .env: the CVAT superuser (created interactively post-boot, step 5) and
Django's secret keys (self-generated on first boot into the persisted
`/mnt/thedatapool/app-data/cvat/keys`).

## 3. DNS

Add `cvat.activescott.com` → same public IP/CNAME target as `phoenix.activescott.com`.
Required before the cert issues (HTTP-01) and before the UI works.

## 4. Deploy + watch

Push to main; the GitHub webhook triggers Flux (no manual `flux reconcile`).

```sh
kubectl --context nas get pods -n cvat -w
kubectl --context nas get certificate -n cvat
kubectl --context nas logs -n cvat deploy/cvat-server -f
curl -s https://cvat.activescott.com/api/server/about
```

First boot is slow: cvat-server's `init` runs all Django migrations; workers crash-loop
until migrations finish — that's normal, they settle.

## 5. First-boot accounts

```sh
kubectl --context nas -n cvat exec -it deploy/cvat-server -- python3 ~/manage.py createsuperuser
```

Then in the UI: create per-person accounts; create an API token for steward tooling
(token auth, not the superuser password).

## 6. Migration from laptop CVAT (steward repo side)

Per `steward/docs/specs/cvat-home-infra-hosting/plan.md`: export local task 1 as
"CVAT for Images 1.1" snapshot, recreate project `blackberry-stem` + labels + guide
(`labeling/label-schema.md`, `POST /api/guides`), load images, import annotations,
verify with `steward-check-labels` against the new URL.

## Gotchas / non-obvious

- **Share on every worker:** the originals share is mounted on cvat-server AND all 7
  workers. Chunks are built lazily by `cvat-worker-chunks`; missing mount there = 500 /
  FileNotFoundError on frames past the first chunk. Learned the hard way on the local
  compose setup (`steward/labeling/docker-compose.override.yml`).
- **hostPath ownership:** kubernetes never chowns hostPath volumes; wrong ownership
  shows up as CrashLoopBackOff with "permission denied" in `kubectl logs`.
- **No Helm on purpose:** the official CVAT chart depends on Bitnami postgres/redis
  charts (banned in this repo, see README "Image source rule").
- **Consensus worker omitted:** if consensus features are ever used in the UI, jobs
  will queue forever until a `cvat-worker-consensus` deployment is added (copy any
  worker in `workers.yaml`, args `[run, worker, consensus]`).
- **Validation:** `kubectl kustomize apps/production/cvat | kubectl --context nas apply
  --dry-run=client --validate=true -f -`. Server-side dry-run reports "namespaces cvat
  not found" for every object until the namespace actually exists — not an error in the
  manifests.

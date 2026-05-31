# photoprism MariaDB 10.8 → 10.11 LTS

## Context

- **Current image**: `mariadb:10.8` in
  `apps/base/photoprism/mariadb-statefulset.yaml`.
- **Target**: `mariadb:10.11` (LTS, community support through Feb 2028).
- **Affected workloads**: three photoprism instances — `oksana`, `scott`,
  `micah` — each with its own `mariadb-0` StatefulSet, but all bumping
  together since they share the base manifest.
- **Storage**: hostPath on `nas` node:
  - `/mnt/thedatapool/app-data/photoprism-oksana/mariadb-data`
  - `/mnt/thedatapool/app-data/photoprism-scott/mariadb/var-lib-mysql`
  - `/mnt/thedatapool/app-data/photoprism-micah/mariadb-data`

## Why upgrade

- MariaDB 10.8 is a non-LTS release; community support ended ~May 2023.
  No security patches.
- 10.11 is the closest LTS upgrade target — supported through Feb 2028.

## Why 10.11 specifically

- LTS (long-term support), conservative jump from 10.8.
- Wire-compatible with the existing photoprism app — the official
  `mariadb` Docker image's entrypoint runs `mariadb-upgrade` on first
  boot of a new server version against an older data dir, so system
  tables and InnoDB structures will be brought current automatically.
- Skipping 10.9 and 10.10 is supported (within the 10.x line).
- 11.x is also LTS-available but represents a larger jump and uses a
  new versioning scheme. 10.11 is the minimal-change LTS landing.

## Approach

Single-commit base image bump. All 3 tenants will roll together as
Flux reconciles. Acceptable blast radius for a home lab — failures
are isolated per StatefulSet (separate Pods, separate hostPaths).

## Backups

**None taken** (per user decision). Justification:

- 10.8 → 10.11 is a minor version jump within the 10.x line; data
  directory format is forward-compatible.
- `mariadb-upgrade` (run automatically by the container entrypoint)
  is idempotent and well-tested for this transition.
- The only realistic loss scenario is a downgrade attempt *after*
  10.11 has touched the datadir — 10.8 will refuse to start against
  a 10.11-modified datadir. We won't downgrade.

## Risk assessment

**Low-moderate.** The forward upgrade is well-trodden territory. The
real risk is operational:

- All 3 mariadb pods restart concurrently — photoprism is unavailable
  for ~2-3 minutes per tenant during the restart + mariadb-upgrade.
- If 10.11 introduces a default that breaks the photoprism client
  (auth plugin, default charset, etc.), all 3 tenants are affected
  at once. Mitigation: validate the first tenant fully before relying
  on the rest.

## Rollback

`git revert <upgrade-commit>` puts the image back to `mariadb:10.8`.
Flux re-applies. The 10.8 server will then encounter a 10.11-touched
datadir and likely refuse to start with a "Table doesn't have the
correct structure" or similar fatal. Recovery would then require:

- Stopping the mariadb pod
- Deleting the datadir contents (host-side, on `nas`)
- Restoring from a logical dump

Since no dump was taken, **rollback is best-effort and assumes the
photoprism app can re-derive metadata from filesystem photos**. This
is acceptable for a home lab.

## Plan

1. Save this `plan.md` to spec dir.
2. Edit `apps/base/photoprism/mariadb-statefulset.yaml`:
   `image: mariadb:10.8` → `image: mariadb:10.11`.
3. Commit (signed) and push to `main`.
4. Wait for Flux reconcile (do not manually `flux reconcile`).
5. Per-tenant validation, in order oksana → scott → micah:
   - `mariadb-0` Pod transitions to `Running, 1/1 Ready` (readiness
     probe runs `mysqladmin status` with root cred from in-container
     env — pass means MariaDB is up *and* root login works).
   - Container log shows `mariadb-upgrade` completed (or "no upgrade
     needed" on the fresh-data case).
   - `photoprism-app-0` Pod stays `Running` and does not crashloop
     trying to reconnect.
   - photoprism container logs show no DB-connection errors after the
     mariadb restart window.
6. Save `summary.md`.

## Validation commands (paste-ready)

```bash
# Watch all 3 mariadb pods
kubectl --context nas get pods -A -l role=mariadb -w

# Image rolled?
for ns in photoprism-oksana photoprism-scott photoprism-micah; do
  echo -n "$ns: "
  kubectl --context nas -n "$ns" get pod mariadb-0 \
    -o jsonpath='{.spec.containers[0].image}{"\t"}{.status.phase}{"\t"}{.status.containerStatuses[0].ready}{"\n"}'
done

# mariadb-upgrade ran (look for "InnoDB" / "Server version" / "Phase"
# messages in startup logs)
for ns in photoprism-oksana photoprism-scott photoprism-micah; do
  echo "--- $ns ---"
  kubectl --context nas -n "$ns" logs mariadb-0 --tail=50 \
    | grep -iE 'version|upgrade|ready for connections|error'
done

# Photoprism app didn't lose its mind
for ns in photoprism-oksana photoprism-scott photoprism-micah; do
  echo "--- $ns ---"
  kubectl --context nas -n "$ns" logs photoprism-app-0 --tail=50 \
    | grep -iE 'error|fatal|cannot connect|database'
done
```

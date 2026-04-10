# PhotoPrism

Two-tenant [PhotoPrism](https://docs.photoprism.app/) deployment (`scott`, `oksana`). Both tenants share the base in `apps/base/photoprism/` and override only paths, hostnames, and tenant labels in their overlays.

- `photos.scott.willeke.com` → namespace `photoprism-scott`
- `photos.oksana.willeke.com` → namespace `photoprism-oksana`

Each tenant has its own MariaDB StatefulSet with hostPath storage on `/mnt/thedatapool/app-data/photoprism-<tenant>/`.

## Backups

`./backup-mariadb.sh` dumps both tenants' MariaDB databases to `~/photoprism-backups` (override with first arg). Run before any upgrade and any time you want a quick logical backup.

```bash
./backup-mariadb.sh
```

## Upgrading

1. Find the target image tag at https://hub.docker.com/r/photoprism/photoprism/tags. Use the date-stamped non-suffixed tag (e.g. `260305`); avoid `preview`, `-postgres`, `-legacy`, `-ce`.
2. Skim https://docs.photoprism.app/release-notes/ for everything between current and target. Look for breaking changes, schema migrations, and explicit "run X command after upgrade" instructions (the **Nov 30, 2025 (251130)** release required `photoprism faces audit --fix` + `photoprism faces index`).
3. Backup both MariaDBs:
   ```bash
   ./backup-mariadb.sh
   ```
4. Bump the image tag in `apps/base/photoprism/photoprism-statefulset.yaml`. Both tenants inherit from base — neither overlay overrides the image.
5. Commit + push. Flux reconciles automatically. Photoprism runs DB migrations on startup.
6. Wait for both pods to become Ready:
   ```bash
   kubectl --context nas -n photoprism-scott wait --for=condition=ready pod/photoprism-app-0 --timeout=10m
   kubectl --context nas -n photoprism-oksana wait --for=condition=ready pod/photoprism-app-0 --timeout=10m
   ```
7. Run any post-upgrade commands the release notes called for, e.g.:
   ```bash
   for ns in photoprism-scott photoprism-oksana; do
     kubectl --context nas -n "$ns" exec photoprism-app-0 -- photoprism faces audit --fix
     kubectl --context nas -n "$ns" exec photoprism-app-0 -- photoprism faces index
   done
   ```
   `photoprism faces index` is long-running; consider launching the two tenants in parallel terminals.

## Rollback

If photoprism fails to start or migrations error out, revert the image-bump commit (Flux rolls back). If the schema is corrupted, restore from the pre-upgrade dump:

```bash
kubectl --context nas exec -i -n <ns> mariadb-0 -- \
  sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' \
  < ~/photoprism-backups/photoprism-<ns>-<timestamp>.sql
```

# Photoprism upgrade summary: 240915 → 260305

## What was done

- **Image bumped** from `photoprism/photoprism:240915` → `260305` in `apps/base/photoprism/photoprism-statefulset.yaml`. Both tenants (scott, oksana) inherit from base.
- **7 DB migrations** applied automatically on startup (20241010 through 20251007). Both tenants migrated cleanly.
- **Backup script** added: `apps/production/photoprism/backup-mariadb.sh`. Used it to dump both MariaDB databases pre-upgrade (scott: 156 MB / 40 tables, oksana: 267 MB / 39 tables). Note: `--routines` flag was removed because scott's `mysql.proc` index is corrupt (pre-existing issue, see follow-up below).
- **README** added at `apps/production/photoprism/README.md` documenting upgrade, backup, and rollback procedures.

## Post-upgrade tasks

### Scott (photoprism-scott)
- `photoprism faces audit --fix` — cleared orphan face references, removed 1 orphan cluster. Completed in ~43s.
- `photoprism faces index` — updated 2,282 markers, recognized 1,582 faces, 735 unknown. Completed in ~31 min. The original kubectl exec stream was reset by peer mid-run but the in-pod process continued and completed.

### Oksana (photoprism-oksana)
- `photoprism faces audit --fix` + `faces index` — ran but hung during re-index phase after recognizing 3,507 faces.
- Restarted pod, retried `faces index` — hung again in marker matching phase.
- **Nuclear path taken**: `photoprism faces reset -f` (wiped all face data) → `photoprism index --force` (full library reindex, 66,120 files in 1h 16m). This completed cleanly with face detection, clustering, and conflict resolution all inline. Resolved 2 ambiguous subjects (Micah, Jonah) and 5,478 conflicts total.

## Follow-up items

1. **Scott's MariaDB `mysql.proc` index is corrupt** — `mariadb-dump --routines` fails with "Index for table 'proc' is corrupt; try to repair it (1034)". This doesn't affect photoprism operation but should be repaired. Run inside scott's mariadb pod:
   ```bash
   kubectl --context nas -n photoprism-scott exec mariadb-0 -- \
     sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "REPAIR TABLE mysql.proc"'
   ```

2. **Oksana face assignments need manual review** — since `faces reset -f` wiped all face data, auto-detected face clusters will need to be re-labeled in the People section of the UI. The full reindex already detected and clustered all faces; they just need names assigned.

3. **Scott full library rescan (optional)** — the 250223 release notes recommended a complete rescan. Scott didn't get one (only faces index). If video playback shows on-the-fly transcoding issues, trigger from UI: Library → Index → "Complete Rescan".

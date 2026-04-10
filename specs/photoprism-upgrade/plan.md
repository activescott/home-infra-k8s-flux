# Photoprism upgrade: 240915 → 260305

## Context

Both photoprism tenants (`scott`, `oksana`) are running `photoprism/photoprism:240915` (Sept 15, 2024) — about 18 months behind. Two notable releases sit between us and current:

- **250223** (Feb 23, 2025) — UI redesign, new hybrid photo/video viewer. Release notes recommend a complete library rescan after this jump or videos may transcode on-the-fly during playback.
- **251130** (Nov 30, 2025) — Facial recognition pipeline upgraded. Release notes recommend running `photoprism faces audit --fix` followed by `photoprism faces index` to resolve inconsistencies. `PHOTOPRISM_DISABLE_TENSORFLOW` is deprecated in favor of granular `PHOTOPRISM_DISABLE_*` flags / `vision.yml`. We don't currently set `PHOTOPRISM_DISABLE_TENSORFLOW`, so no env-var migration is required.
- **250425** (Apr 25, 2025) — TensorFlow upgraded from v1.15.2 → v2.18.0. Bundled in the image, no action needed beyond the rescan above.

Target version: **`photoprism/photoprism:260305`** — the latest stable tag on Docker Hub (released Mar 5, 2026; `latest` and `ubuntu` point to it). The `260407` "preview" tag and `260305-postgres` are not appropriate (preview / wrong DB).

## Files to modify

Single change. Both overlays inherit from the base, so one image bump applies to both tenants.

- `apps/base/photoprism/photoprism-statefulset.yaml:26` — change `image: photoprism/photoprism:240915` → `image: photoprism/photoprism:260305`

No other files need editing. Verified:
- Neither overlay's `patch-photoprism-statefulset.yaml` overrides the image.
- Neither sets `PHOTOPRISM_DISABLE_TENSORFLOW` (the deprecated var).
- Storage paths are unchanged.

## Pre-upgrade: backup MariaDB

Both tenants have a MariaDB 10.8 StatefulSet with hostPath storage:
- `scott`: `/mnt/thedatapool/app-data/photoprism-scott/mariadb/var-lib-mysql`
- `oksana`: `/mnt/thedatapool/app-data/photoprism-oksana/mariadb-data`

Take a logical dump of each before kicking off the upgrade so we have a fast rollback path if photoprism's startup migration corrupts something:

```bash
for ns in photoprism-scott photoprism-oksana; do
  kubectl --context nas exec -n "$ns" mariadb-0 -- \
    sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers "$MARIADB_DATABASE"' \
    > "/tmp/photoprism-${ns}-$(date +%Y%m%d-%H%M%S).sql"
done
```

Verify each dump is non-empty and contains `CREATE TABLE` statements before proceeding.

## Rollout

1. Edit `apps/base/photoprism/photoprism-statefulset.yaml:26` (image bump only).
2. Commit + push. Flux reconciles automatically.
3. Watch each StatefulSet roll. Photoprism runs DB migrations on startup; for an 18-month jump expect this to take a few minutes per tenant. Watch logs:
   ```bash
   kubectl --context nas -n photoprism-scott logs -f photoprism-app-0
   kubectl --context nas -n photoprism-oksana logs -f photoprism-app-0
   ```
4. Wait for both pods to become Ready (`/api/v1/status` readiness probe passes).

## Post-upgrade: faces reindex (per tenant)

Per the 251130 release notes. Run on each tenant after the pod is healthy:

```bash
for ns in photoprism-scott photoprism-oksana; do
  echo "=== $ns: faces audit --fix ==="
  kubectl --context nas exec -n "$ns" photoprism-app-0 -- photoprism faces audit --fix
  echo "=== $ns: faces index ==="
  kubectl --context nas exec -n "$ns" photoprism-app-0 -- photoprism faces index
done
```

Both commands are long-running. Run them sequentially per tenant; consider running scott and oksana in parallel terminals if you want to save wall time. Capture output so we can confirm what was fixed.

## Optional: full library rescan (deferred)

The 250223 release notes recommend a complete rescan. This is expensive (large libraries → hours of CPU + IO). My recommendation: **do NOT run this automatically as part of the upgrade.** Instead, verify both UIs work normally after the faces reindex, then trigger a rescan opportunistically from the UI (Library → Index → "Complete Rescan") if/when video playback shows transcoding issues. Document it in the README as a known follow-up.

## Verification

After the rollout and faces commands complete:

1. **Pods healthy:**
   ```bash
   kubectl --context nas -n photoprism-scott get pods
   kubectl --context nas -n photoprism-oksana get pods
   ```
2. **No error spam in logs** (check the last ~200 lines of each photoprism pod).
3. **UIs load** at `https://photos.scott.willeke.com/` and `https://photos.oksana.willeke.com/` — log in, confirm photo grid renders, open one photo, scrub a video.
4. **People view** still shows known faces (this is the main thing the faces reindex affects).
5. **Image actually bumped:**
   ```bash
   kubectl --context nas -n photoprism-scott get pod photoprism-app-0 -o jsonpath='{.spec.containers[0].image}'
   kubectl --context nas -n photoprism-oksana get pod photoprism-app-0 -o jsonpath='{.spec.containers[0].image}'
   ```

## Rollback

If photoprism fails to start or the DB migration errors out:

1. Revert the image bump commit and push (Flux will roll the StatefulSets back to `240915`).
2. If the schema is broken (the DB dumps were taken at the v1 schema), restore the affected tenant from the pre-upgrade dump:
   ```bash
   kubectl --context nas exec -i -n <ns> mariadb-0 -- \
     sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' \
     < /tmp/photoprism-<ns>-<timestamp>.sql
   ```

## README update

After the upgrade succeeds, add a short `apps/production/photoprism/README.md` (none exists today) documenting:
- The upgrade procedure (image bump in base affects both tenants)
- The post-upgrade `photoprism faces audit --fix` + `photoprism faces index` requirement when the release notes call for it
- The pre-upgrade mariadb dump command
- Pointer to https://docs.photoprism.app/release-notes/ for breaking changes

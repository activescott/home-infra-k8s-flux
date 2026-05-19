# Summary: Collect Plex file-based logs into Loki

## What was done

### 1. Alloy HelmRelease (`apps/production/monitoring/alloy/helmrelease.yaml`)

- Added `alloy.mounts.extra` with a read-only volume mount at `/mnt/plex-logs`
- Added `controller.volumes.extra` with a hostPath volume pointing to the Plex log directory on the host (`/mnt/thedatapool/app-data/plex/config/Library/Application Support/Plex Media Server/Logs`) using `DirectoryOrCreate` type
- Added Alloy config components in `configMap.content`:
  - `local.file_match "plex_logs"` - discovers `*.log` files, applies static labels (`namespace=plex`, `app=plex`, `source=file`, `service_name=plex/plex`)
  - `loki.source.file "plex_logs"` - tails discovered files with `tail_from_end = true`
  - `loki.process "plex"` - parses the Plex log format via `stage.regex`, normalizes level to lowercase via `stage.replace`, extracts message via `stage.output`, promotes `level` to a label, adds `filename` as structured metadata

### 2. Loki HelmRelease (`apps/production/monitoring/loki/helmrelease.yaml`)

- Added `retention_stream` under `limits_config` with a 30-day retention for streams matching `{source="file", namespace="plex"}`

### 3. Monitoring README (`apps/production/monitoring/README.md`)

- Added "Plex File Log Collection" subsection documenting the file log pipeline, labels, query examples, and retention policy
- Removed the old note about Plex logs not appearing in Loki (no longer accurate)

## Verification steps

1. Check Alloy pod is running: `kubectl --context nas get pods -n monitoring -l app.kubernetes.io/name=alloy`
2. Check Alloy logs for errors: `kubectl --context nas logs -n monitoring -l app.kubernetes.io/name=alloy --tail=50`
3. Check Plex pod is healthy: `kubectl --context nas get pods -n plex`
4. Query Loki for plex file logs: `{namespace="plex", source="file"}`
5. Verify `filename` structured metadata distinguishes log files

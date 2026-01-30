# Plan: Collect Plex file-based logs into Loki

## Context

Plex writes most of its logs to files at `/config/Library/Application Support/Plex Media Server/Logs/` rather than stdout. The `/config` volume is a hostPath at `/mnt/thedatapool/app-data/plex/config`, so the logs are accessible on the host. There are ~164 log files totaling 4.6MB. The active logs have names like `Plex Media Server.log` with rolled copies as `Plex Media Server.1.log`, etc.

Plex log format: `Jan 27, 2026 12:39:48.421 [139766060964664] INFO - message text here`

## Changes

### 1. Alloy HelmRelease (`apps/production/monitoring/alloy/helmrelease.yaml`)

**Add hostPath volume + mount** via the chart's values:
```yaml
alloy:
  mounts:
    extra:
      - name: plex-logs
        mountPath: /mnt/plex-logs
        readOnly: true

controller:
  volumes:
    extra:
      - name: plex-logs
        hostPath:
          path: "/mnt/thedatapool/app-data/plex/config/Library/Application Support/Plex Media Server/Logs"
          type: DirectoryOrCreate
```

`DirectoryOrCreate` prevents Alloy pods on nodes without the Plex data from failing to start (they'll just see an empty directory).

**Add Alloy config components** for file-based log collection:
- `local.file_match "plex_logs"` -- discovers `*.log` files under `/mnt/plex-logs/`, applies static labels (`namespace=plex`, `app=plex`, `source=file`, `service_name=plex/plex`)
- `loki.source.file "plex_logs"` -- tails discovered log files, starts from end of file (`tail_from_end = true`) to avoid ingesting all historical data on first startup
- `loki.process "plex"` -- parses the Plex log format with `stage.regex`, normalizes level to lowercase, extracts the message, promotes `level` to a label, adds `filename` as structured metadata
- Forwards to existing `loki.write.default`

### 2. Loki HelmRelease (`apps/production/monitoring/loki/helmrelease.yaml`)

Add `retention_stream` under `limits_config` to give plex file logs a 30-day retention (vs 180d default):
```yaml
limits_config:
  retention_period: 180d
  retention_stream:
    - selector: '{source="file", namespace="plex"}'
      priority: 1
      period: 30d
```

### 3. Monitoring README (`apps/production/monitoring/README.md`)

Add a note about the Plex file log collection under the "Notes" section.

## Files modified

1. `apps/production/monitoring/alloy/helmrelease.yaml` -- volume mount + new config components
2. `apps/production/monitoring/loki/helmrelease.yaml` -- per-stream retention
3. `apps/production/monitoring/README.md` -- documentation

## Verification

After Flux reconciles (or via `flux reconcile helmrelease alloy -n monitoring && flux reconcile helmrelease loki -n monitoring`):
1. Check Alloy pod is running: `kubectl --context nas get pods -n monitoring -l app.kubernetes.io/name=alloy`
2. Check Alloy logs for errors: `kubectl --context nas logs -n monitoring -l app.kubernetes.io/name=alloy --tail=50`
3. Query Loki for plex file logs via the Grafana MCP server: `{namespace="plex", source="file"}`
4. Verify the `filename` structured metadata distinguishes log files

# Summary: Handle non-JSON log lines in Alloy pipeline

## What was done

Modified `apps/production/monitoring/alloy/helmrelease.yaml` to extract `msg` as structured metadata in the Alloy log processing pipeline. Four changes:

1. **`stage.json`** — Added `msg = "msg"` alongside existing `level` extraction
2. **New `stage.template`** — Falls back `msg` to the full log line (`.Entry`) when `stage.json` didn't extract it (non-JSON lines)
3. **New `stage.structured_metadata`** — Stores `msg` as structured metadata so it's visible in Grafana without `| json`
4. **Updated comments** — Header comment block and inline comments updated to reflect the new pipeline stages

## Verification results

Confirmed working on the `nas` cluster after Flux reconciliation and Alloy config reload:

- **Non-JSON lines**: `msg` contains the full log line (e.g. `POST /mcp 202 - - 5.502 ms`), `level` remains `<no value>`
- **JSON lines**: `msg` contains the pino message field (e.g. `MCP GET request rejected: SSE transport is deprecated...`), `level` correctly mapped (e.g. `info`)
- **No config errors** in Alloy logs after reload

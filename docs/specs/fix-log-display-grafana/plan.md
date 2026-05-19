# Plan: Fix Log Display in Grafana

## Problem
Logs in Grafana Loki are noisy and unstructured:
- Health check probe requests (`GET /health/readiness`, `GET /health/liveness`) dominate the log output
- Pino JSON log lines are displayed as raw JSON instead of being parsed into structured fields
- Multi-line stack traces are split across separate log entries
- No level-based filtering is available in Grafana

## Root Cause
Alloy was forwarding raw log lines directly from `loki.source.kubernetes` to `loki.write` without any processing pipeline in between.

## Solution

### Part 1: Alloy Pipeline (`apps/production/monitoring/alloy/helmrelease.yaml`)

Insert a `loki.process "default"` block between the log source and Loki writer with these stages:

1. **`stage.multiline`** - Join multi-line stack traces into single entries
   - Pattern: `^(\{|\S)` — JSON lines or non-whitespace start new entries
   - Indented continuation lines appended to preceding entry
   - `max_wait_time = "3s"`, `max_lines = 128`

2. **`stage.drop`** - Drop health check request logs
   - Pattern: `.*GET /(api/)?health/(readiness|liveness).*`
   - Covers tinkerbell (`/health/*`) and gpupoet (`/api/health/*`)

3. **`stage.json`** - Parse pino JSON log lines
   - Extract: `level`, `msg`, `module`, `time`
   - Non-JSON lines pass through unmodified (stage.json silently skips unparseable lines)

4. **`stage.template`** - Map pino numeric levels to strings
   - 10->trace, 20->debug, 30->info, 40->warn, 50->error, 60->fatal

5. **`stage.labels`** - Promote `level` to a Loki label for efficient `{level="error"}` queries

6. **`stage.structured_metadata`** - Attach `msg` and `module` as structured metadata

**Important:** The `stage.template` value uses River `{{ }}` syntax which conflicts with Helm's Go template processing (the Alloy chart passes `configMap.content` through `tpl`). The River template must be wrapped in Go raw string output syntax (`` {{` ... `}} ``) so Helm emits it literally.

### Part 2: Loki Config (`apps/production/monitoring/loki/helmrelease.yaml`)

Add `allow_structured_metadata: true` to `limits_config`.

### Part 3: Tinkerbell JSDOM Fix (tinkerbell repo)

Suppress JSDOM CSS/HTML parsing warnings from leaking to stdout by using `VirtualConsole` without `.sendTo(console)`.

### Part 4: Ramblefeed & GPUPoet

No changes needed — both already use pino JSON output.

## Files Modified

| File | Repo | Changes |
|------|------|---------|
| `apps/production/monitoring/alloy/helmrelease.yaml` | home-infra-k8s-flux | Add loki.process pipeline |
| `apps/production/monitoring/loki/helmrelease.yaml` | home-infra-k8s-flux | Enable structured metadata |
| `packages/scraping/src/readability.ts` | tinkerbell | JSDOM VirtualConsole |

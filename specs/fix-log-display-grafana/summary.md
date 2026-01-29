# Fix Log Display in Grafana — Implementation Summary

## Changes Made

### Part 1: Alloy Pipeline (`apps/production/monitoring/alloy/helmrelease.yaml`)

Inserted a `loki.process "default"` block between `loki.source.kubernetes` and `loki.write`. The source's `forward_to` now points to `loki.process.default.receiver` instead of `loki.write.default.receiver`.

Processing stages added (in order):

1. **`stage.multiline`** — Joins stack trace continuation lines. New entries start with `{` (JSON) or any non-whitespace char. Indented lines appended to preceding entry. `max_wait_time = "3s"`, `max_lines = 128`.

2. **`stage.drop`** — Drops health check logs matching `.*GET /(api/)?health/(readiness|liveness).*`.

3. **`stage.json`** — Parses pino JSON, extracts `level`, `msg`, `module`, `time`. Non-JSON lines pass through unmodified.

4. **`stage.replace` (x6)** — Maps pino numeric levels to strings: 10->trace, 20->debug, 30->info, 40->warn, 50->error, 60->fatal. Uses `stage.replace` instead of `stage.template` because `stage.template` uses River's double-curly-brace syntax which conflicts with Helm's `tpl` function (the Alloy chart passes `configMap.content` through Go template processing).

5. **`stage.output`** — Replaces the raw JSON log line body with just the extracted `msg` field, so Grafana shows clean human-readable messages. Non-JSON lines pass through unchanged since `stage.json` doesn't populate the extracted map for unparseable lines, making `stage.output` a no-op.

6. **`stage.labels`** — Promotes `level` to a Loki label for efficient `{level="error"}` queries.

7. **`stage.structured_metadata`** — Attaches `msg` and `module` as structured metadata searchable in LogQL.

### Part 2: Loki Config (`apps/production/monitoring/loki/helmrelease.yaml`)

Added `allow_structured_metadata: true` to `limits_config` to enable the structured metadata feature in Loki.

### Part 3: Tinkerbell JSDOM Fix (`tinkerbell` repo: `packages/scraping/src/readability.ts`)

- Imported `VirtualConsole` from `jsdom`
- Added `new VirtualConsole()` (without `.sendTo(console)`) to both JSDOM call sites:
  - `extractReadableContent` — `new JSDOM(html, { url, virtualConsole })`
  - `prepareWikipediaContent` — `new JSDOM(html, { virtualConsole })`
- This prevents JSDOM CSS/HTML parsing warnings from leaking to stdout/stderr

### Part 4: Ramblefeed & GPUPoet

No changes needed — both already use pino JSON output. The Alloy pipeline handles them uniformly.

## Issues Encountered

### Helm tpl conflict
The Alloy Helm chart passes `configMap.content` through Go's `tpl` function, which interprets `{{ }}` as Go template actions. This caused the initial HelmRelease upgrade to fail silently — the deployed ConfigMap retained the old config (no processing pipeline) while the HelmRelease showed a failed status.

- **`stage.template`** uses River's `{{ }}` syntax for conditional logic, which `tpl` tried to parse as Go template actions. The `\"` inside those actions is not valid Go template syntax, causing `unexpected "\\" in operand`.
- **Backtick escaping** (`{{` `` ` `` `...` `` ` `` `}}`) also failed with `missing value for command`.
- **Comments** containing literal `{{ }}` (e.g., "River's {{ }} syntax") were also parsed by `tpl`.
- **Solution**: Replaced `stage.template` with 6 `stage.replace` blocks using plain regex, and rewrote comments to avoid double-curly-brace literals entirely.

## Verification

Confirmed working:
- Health check probe logs (`GET /health/readiness`, `GET /health/liveness`) are dropped
- Pino JSON log lines display as clean `msg` text instead of raw JSON
- Plain text HTTP logs (e.g., `POST /mcp 200 - - 2.412 ms`) pass through unchanged
- Structured metadata fields (level, msg, module) are extracted and searchable

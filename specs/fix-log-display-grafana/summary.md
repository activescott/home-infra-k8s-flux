# Fix Log Display in Grafana — Implementation Summary

## Changes Made

### Part 1: Alloy Pipeline (`apps/production/monitoring/alloy/helmrelease.yaml`)

Inserted a `loki.process "default"` block between `loki.source.kubernetes` and `loki.write`. The source's `forward_to` now points to `loki.process.default.receiver` instead of `loki.write.default.receiver`.

Processing stages added (in order):

1. **`stage.multiline`** — Joins stack trace continuation lines. New entries start with `{` (JSON) or any non-whitespace char. Indented lines appended to preceding entry. `max_wait_time = "3s"`, `max_lines = 128`.

2. **`stage.drop`** — Drops health check logs matching `.*GET /(api/)?health/(readiness|liveness).*`.

3. **`stage.json`** — Parses pino JSON, extracts `level`, `msg`, `module`, `time`. Non-JSON lines pass through unmodified.

4. **`stage.template`** — Maps pino numeric levels to strings: 10->trace, 20->debug, 30->info, 40->warn, 50->error, 60->fatal.

5. **`stage.labels`** — Promotes `level` to a Loki label for efficient `{level="error"}` queries.

6. **`stage.structured_metadata`** — Attaches `msg` and `module` as structured metadata searchable in LogQL.

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

## Verification Steps

After Flux deploys the Alloy and Loki changes:

1. `kubectl -n monitoring rollout status daemonset/alloy`
2. `kubectl -n monitoring logs -l app.kubernetes.io/name=alloy --tail=50` — check for config errors
3. Grafana Explore: `{namespace="tinkerbell-prod"} |= "health"` — expect no results
4. `{namespace="tinkerbell-prod", level="info"}` — expect results with level label
5. Expand a log entry — verify `msg` and `module` in structured metadata
6. `{namespace="gpupoet-prod", container="cache-revalidation"}` — CronJob plain text preserved
7. After tinkerbell JSDOM fix: `{namespace="tinkerbell-prod"} |= "display:"` — expect no CSS garbage

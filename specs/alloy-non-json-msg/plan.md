# Plan: Handle non-JSON log lines in Alloy pipeline

## Context

Non-JSON log lines (e.g. react-router's `POST /mcp 200 - - 2.781 ms`) show `<no value>` for both `level` and `msg` in Grafana. Confirmed by querying Loki:

- **JSON lines** (e.g. `tinkerbell-prod/app`): `{"level":30,"time":...,"msg":"MCP server connected to transport"}` — Grafana's `| json` extracts `msg` and `level` fine
- **Non-JSON lines** (e.g. `tinkerbell-prod/app`, `ramblefeed-prod/app`): `POST /mcp 200 - - 2.781 ms` — both `level` and `msg` show as `<no value>`

Root cause: `stage.json` silently skips non-JSON lines, so nothing is extracted. Currently it only extracts `level`, not `msg`.

Goal: Make `msg` always populated — from JSON's `msg` field for JSON lines, from the full log line for non-JSON lines. Store as structured metadata so it's visible in Grafana without `| json`. Leave `level` empty for non-JSON lines (per user preference).

## Changes

**File:** `apps/production/monitoring/alloy/helmrelease.yaml`

### 1. Extract `msg` from JSON logs alongside `level`

Update `stage.json` (line 116-119) to also extract `msg`:

```river
stage.json {
  expressions = {
    level = "level",
    msg   = "msg",
  }
}
```

### 2. Fallback `msg` to the full log line for non-JSON entries

Add a new `stage.template` immediately after the `stage.json` block. Uses Go template `.Entry` to access the raw log line when `msg` is empty (non-JSON lines):

```river
stage.template {
  source   = "msg"
  template = "{{ "{{" }} if .Value {{ "}}" }}{{ "{{" }} .Value {{ "}}" }}{{ "{{" }} else {{ "}}" }}{{ "{{" }} .Entry {{ "}}" }}{{ "{{" }} end {{ "}}" }}"
}
```

### 3. Store `msg` as structured metadata

Add `stage.structured_metadata` after the level label promotion (line 135-138) and before `forward_to`. This makes `msg` always visible in Grafana without needing `| json`:

```river
stage.structured_metadata {
  values = {
    msg = "",
  }
}
```

### 4. Update pipeline comments

Update the header comment block (lines 40-46) and the inline comment at line 141 to reflect that `msg` is now extracted and stored as structured metadata.

## Verification

1. After Flux reconciles, check Alloy pod logs for config errors:
   `kubectl --context minikube logs -n monitoring -l app.kubernetes.io/name=alloy --tail=50`
2. Query non-JSON logs and confirm `msg` is populated:
   `{service_name="tinkerbell-prod/app"} !~ "^\\{"` — `msg` should contain the full log line
3. Query JSON logs and confirm `msg` still shows the pino message:
   `{service_name="tinkerbell-prod/app"} |~ "^\\{"` — `msg` should be e.g. "MCP server connected to transport"
4. Confirm `level` is still `<no value>` for non-JSON lines (no default applied)

# TinkerbellAppErrorVolumeElevated

`TinkerbellAppErrorVolumeElevated` (rule group `tinkerbell-log-health` in
`prometheus/helmrelease.yaml`, alongside `TinkerbellAppWarnVolumeElevated`) is a
general volume backstop, not tied to one failure mode, so what's actually wrong
varies. Diagnosed cause so far:

- Usually a relevance-guard retry that excludes the one provider it just
  rejected, leaving nothing to query, so it logs at error level even though the
  caller goes on to serve the first attempt, a handled condition rather than a
  real failure. See activescott/tinkerbell#187. Check each error line's `errors`
  field (empty in the handled case) and whether it's followed within
  milliseconds by a "Validation retry search failed, serving first attempt"
  warn line: `{namespace="tinkerbell-prod", level=~"error|fatal"} | json`.

File the triage issue in `activescott/tinkerbell`, not here: the rule lives in this
repo, but the code it watches does not.

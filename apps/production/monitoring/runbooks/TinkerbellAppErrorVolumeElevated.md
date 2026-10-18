# TinkerbellAppErrorVolumeElevated

`TinkerbellAppErrorVolumeElevated` (rule group `tinkerbell-log-health` in
`prometheus/helmrelease.yaml`, alongside `TinkerbellAppWarnVolumeElevated`) is a
general volume backstop, not tied to one failure mode, so what's actually wrong
varies. Diagnosed causes so far:

- Usually a relevance-guard retry that excludes the one provider it just
  rejected, leaving nothing to query, so it logs at error level even though the
  caller goes on to serve the first attempt, a handled condition rather than a
  real failure. See activescott/tinkerbell#187. Check each error line's `errors`
  field (empty in the handled case) and whether it's followed within
  milliseconds by a "Validation retry search failed, serving first attempt"
  warn line: `{namespace="tinkerbell-prod", level=~"error|fatal"} | json`.
- "Both primary and fallback models failed" from `web_fetch` AI extraction. The
  `primaryError` and `fallbackError` fields name the reason: a caller-supplied
  schema with a nested object missing `additionalProperties: false`, page
  content too long for the model ("Please reduce the length of the messages or
  completion"), or a Groq TPM rate limit, which both gpt-oss models share. See
  activescott/tinkerbell#273. A 429 that still reaches error level after the fix
  there means the org quota stayed exhausted for longer than the retries waited.

File the triage issue in `activescott/tinkerbell`, not here: the rule lives in this
repo, but the code it watches does not.

# TinkerbellAppWarnVolumeElevated

`TinkerbellAppWarnVolumeElevated` (rule group `tinkerbell-log-health` in
`prometheus/helmrelease.yaml`, alongside `TinkerbellAppErrorVolumeElevated`) is a
general volume backstop, not tied to one failure mode, so what's actually wrong
varies. Diagnosed cause so far:

- Usually the relevance guard rejecting `searxng-google` results on job-board
  queries (quoted `site:` operators plus `OR`), which runs a chronic ~50%
  rejection rate, and a burst of concurrent searches is what pushes it past the
  hourly threshold. See activescott/tinkerbell#186. Breakdown by message:
  `topk(10, sum by (msg) (count_over_time({namespace="tinkerbell-prod", level="warn"}[1h])))`.

File the triage issue in `activescott/tinkerbell`, not here: the rule lives in this
repo, but the code it watches does not.

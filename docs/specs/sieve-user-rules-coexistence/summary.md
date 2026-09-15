# Summary — Sieve reconciler destroyed user filter rules, and the alert that almost didn't work

Status as of 2026-09-14. Plan and full design rationale: [plan.md](plan.md).

## What happened

Scott wrote filter rules in Bulwark on 2026-09-13. By the morning of 2026-09-14 they were
gone, and the Filters page showed one locked "External rule 1" holding
`include :global "archive-all";`.

`stalwart-sieve-reconcile` (daily, 04:43) overwrote the account's Sieve script. The old code
did an unconditional `put_script` whenever the stored body differed from git, guarded only by
a check that the active script had a *different name* — which never fires, because Bulwark
edits the account's single script and that script **is** `archive-all`. User rules were
indistinguishable from body drift.

**The rules were unrecoverable.** `PUTSCRIPT` overwrites in place, no backup existed, and
Stalwart does not version Sieve scripts.

## Why the rules and the admin rule have to share one script

Both halves are pinned in place, which is what forced a merge rather than a split:

- Ingest runs only the account's **active** script (`PrincipalField::ActiveScriptId`), and a
  system Sieve script cannot `fileinto` — no `Event::FileInto`. So the archive logic cannot
  move out of the user's script.
- Bulwark manages a **single account-scoped script** and cannot select or create named
  scripts (`getSieveScript` / `createSieveScript` / `updateSieveScript`). So an
  `include :personal "user-rules"` split is unreachable from the UI.

## What shipped

| Commit | Change |
| --- | --- |
| `afc4ed1` | merge-not-replace reconciler, ERROR logging, first alert attempt |
| `62beda7` | merge of `origin/main` |
| `aec246a` | gauges replace the counter; three alerts; dashboard panels |
| `5a166a1` | 26h expiry on level gauges so the alert can clear |

Admin content is delimited by marker comments and only that region is rewritten:

```sieve
# >>> BEGIN stalwart-sieve-reconcile managed block -- do not edit <<<
require ["include"];
include :global "archive-all";
# >>> END stalwart-sieve-reconcile managed block <<<
```

Decision table: no active script → install; markers present → merge region, preserve every
other byte; legacy two-liner → migrate once; **anything else → skip and report**. The last
row is the bug fix. The pre-write body is logged, since nothing else backs it up.

This survives Bulwark because it preserves non-metadata comments, keeps Sieve it cannot model
as a locked "External rule", and never moves or removes existing `require` lines.

## Two alerting bugs found by testing, not by review

Both would have shipped silently. Neither was visible in the code.

**1. A counter cannot alert on a daily job.** The first alert was
`increase(loki_process_custom_stalwart_sieve_unmanaged_total[26h]) > 0`. Forcing a bad run
produced a series reading `[1, 1, 1]` — flat — so `increase` evaluated to **0** and the alert
stayed `inactive`. A once-daily job increments once; `increase` measures a delta, not a
level. It would have alerted only on a *second* consecutive bad day. The neighbouring
counters (auth, delivery) work because those failures arrive in bursts, which is why the
pattern looked correct.

Fix: the job ends every run with a summary line, parsed into gauges holding current state.

**2. Every run created a new series.** The gauges inherit the log entry's labels, and the
entry comes from a CronJob pod whose name changes each run — `pod="...-233545-m9fc8"`. So
`action = "set"` never overwrote anything, and with the 168h `max_idle_duration` used
elsewhere, `sum()` would have added up a week of runs: one bad day would hold the alert on
for seven days after being fixed.

Fix: level gauges expire after 26h — two hours past the next daily run. Consequence to know
when verifying a fix: **clearing takes up to ~2h**, because the previous bad run is still
counted until its series expires.

## The alerting chain

```
sieve-reconcile.py  "sieve-reconcile: run summary: accounts=N unmanaged=M failed=F lastrun=T"
        ↓ (phrase + field names are an interface — changing either side silently breaks it)
alloy/helmrelease.yaml   stage.regex → 3 gauges
        ↓
prometheus/helmrelease.yaml   3 alerts → AlertManager → Telegram
        ↓
grafana/dashboards/email.json   3 stat panels under "Alert conditions"
```

| Alert | Expression | Catches |
| --- | --- | --- |
| `StalwartSieveArchiveRuleMissing` | `sum(..._unmanaged_accounts) > 0` | a mailbox not archiving |
| `StalwartSieveReconcileErrors` | `sum(..._failed_accounts) > 0` | job failing outright |
| `StalwartSieveReconcileNotRunning` | `time() - max(..._last_run_seconds) > 172800` | job stopped running |

The third exists because `max_idle_duration` keeps Alloy exporting the last value long after
a job dies — "no data" never arrives to signal it. A timestamp *value* goes stale visibly.

The dashboard's existing "Firing alerts" and "Firing now" panels already match
`alertname=~"Stalwart.*|EmailRelay.*"`, so the new alerts appear there with no query change.

## Quick commands

```bash
# Run the reconciler on demand (runs the DEPLOYED ConfigMap, not the working tree)
./scripts/stalwart-apply sieve-reconcile

# Dry run — no writes
kubectl --context nas -n email-stalwart create job sieve-dry-$(date +%s) \
  --from=cronjob/stalwart-sieve-reconcile --dry-run=client -o yaml \
  | yq '.spec.template.spec.containers[0].env += [{"name":"SIEVE_DRY_RUN","value":"1"}]' \
  | kubectl --context nas -n email-stalwart apply -f -

# Force a skip to exercise the alert path end to end. Writes nothing: the skip branch
# returns before any put_script. Override only the marker so the stored script stops
# being recognised.
#   SIEVE_MANAGED_BEGIN="# marker that intentionally does not match"

# Merge-logic unit tests (no server needed)
python3 test_merge.py   # 21 cases: Bulwark round-trip, drift repair, skip, stray include
```

Expected outcomes: `ok` (healthy), `migrated` (first run after this change), `installed`
(no active script), `skipped` (**refusing to overwrite — alerts**).

## Gotchas worth keeping

- **`stalwart-apply` runs the deployed ConfigMap**, never the working tree. Commit and let
  Flux reconcile before testing.
- **Alloy processes logs as they stream.** A run that happens before Alloy picks up new
  config is not retroactively parsed — reload first, then re-run the job.
- **ConfigMap → pod is not instant.** The kubelet sync plus the config-reloader took a few
  minutes each time; poll the file inside the pod rather than trusting the ConfigMap.
- **A missing counter looks exactly like a healthy cluster.** These series do not exist until
  the first matching line. Verify by forcing the condition, never by observing silence.
- **`sum()`, not `max()`**, on the level gauges: one run reporting 2 bad accounts must not
  read as 2 series of 1. See `monitoring/README.md` on per-line labels.
- **An Alloy restart replays retained job pod logs.** Restarting Alloy to clear the test
  alert did the opposite — it re-tailed the still-existing test Job's pod from the start and
  re-set the gauge to 1. To actually clear a gauge you must delete the Job whose log set it
  *and then* restart Alloy. The same mechanism means that after any Alloy restart these
  gauges reflect whichever retained job pod was replayed last, not necessarily the newest
  run, until the next real run corrects it. `..._last_run_seconds` (and the "hours since
  run" panel) is how you tell — treat a stale timestamp as "these numbers are not current".
- **`stalwart-apply sieve-reconcile` deletes its Job on completion**, so its pod can vanish
  before Alloy tails it and the run may never reach the metrics at all. Observed: a clean run
  left `last_run_seconds` still showing the previous run. The daily CronJob is unaffected —
  `successfulJobsHistoryLimit: 3` keeps its pods around. When testing metrics specifically,
  create the Job with `kubectl create job --from=cronjob/...` and leave it in place until the
  gauge is scraped.

## Verified end to end on 2026-09-14

Forced a skip (writes nothing — the skip branch returns before any `put_script`) and watched
the whole chain:

| Check | Result |
| --- | --- |
| Reconciler migrates the legacy body | `migrated — legacy body wrapped in managed markers` |
| Re-run is idempotent | `ok — managed block already current` |
| Merge unit tests | 21/21 pass, incl. simulated Bulwark round-trip and drift repair |
| Forced bad run emits | `run summary: accounts=1 unmanaged=1 failed=0` |
| Gauge reaches Prometheus | `sum(..._unmanaged_accounts) = 1` |
| Alert fires | `ALERTS{alertname="StalwartSieveArchiveRuleMissing"} alertstate="firing"` |
| Clean run clears it | gauge back to `0`, no alerts firing |
| Rules loaded | all three `health: ok`, `lastError: null` |
| Dashboard | 37 panels, three Sieve stats at `y=18` |

During cleanup a `kubectl delete job -l job-name` matched every Job in `email-stalwart`, not
just the test ones, removing completed Job history including a 14-day-old
`stalwart-plan-dryrun`. Completed Job records only — no config, mail or cluster state — and
Loki still holds the log lines. Use explicit job names.

## Not done

- **Scott's original rules are gone and must be re-authored.** Safe to do now — the managed
  block is a locked External rule and the job preserves everything around it.
- A user rule containing `stop` placed *above* the managed block would silently disable
  archiving. Not preventable from the reconciler; detectable by checking for `stop` before
  the managed region. Not built.
- Backup is log-only, bounded by `successfulJobsHistoryLimit: 3`. A rolling backup *script*
  was rejected: Bulwark cannot choose among named scripts, so a second script risks the UI
  editing the wrong one, and `automation` has no `sieveDeleteScript` to ever remove it.

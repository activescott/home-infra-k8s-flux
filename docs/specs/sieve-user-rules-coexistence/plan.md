# Let users write their own Sieve rules without the reconciler eating them

## Task 0 — save this plan

Save this plan to `docs/specs/sieve-user-rules-coexistence/plan.md` before touching code.

## What happened

On 2026-09-13 Scott created filter rules in Bulwark. By the morning of 2026-09-14 they
were gone, and the Filters page showed a single locked "External rule 1" containing
`include :global "archive-all";`.

`stalwart-sieve-reconcile` destroyed them. It runs daily at 04:43
(`sieve-reconcile-cronjob.yaml:21`); the run 12h before the report was
`stalwart-sieve-reconcile-29823103`, `Complete`.

The mechanism is `sieve-reconcile.py:182-190`:

```python
if SCRIPT_NAME in scripts:
    current = sieve.get_script(SCRIPT_NAME)
    if normalise(current) == normalise(SCRIPT_BODY) and active == SCRIPT_NAME:
        return "ok", "already current"
    sieve.put_script(SCRIPT_NAME, SCRIPT_BODY)   # unconditional clobber
    sieve.set_active(SCRIPT_NAME)
    return "updated", "body drifted or was inactive"
```

The module docstring claims "This never overwrites a script somebody else wrote", and the
guard at `:179` does skip an account whose active script has a **different name**. That
guard is defeated by a name collision: Bulwark edits the account's one script, which *is*
`archive-all`. User rules written into it are indistinguishable from body drift, so the job
replaced the whole body with git's two-liner.

The rules are unrecoverable. `PUTSCRIPT` overwrites in place, the job kept no backup, and
Stalwart does not version Sieve scripts.

## Why the obvious fixes do not work

**Move the admin logic out of the user's script.** Not possible. `sieve_script_ingest` runs
only the account's active script, from `PrincipalField::ActiveScriptId`, and a system Sieve
script cannot `fileinto` — there is no `Event::FileInto`
(`stalwart-config-as-code/plan.md:248`). The archive logic has to execute inside the user's
active script.

**Split into two scripts — managed active shim with `include :personal "user-rules"`.**
Not possible. Bulwark manages a single account-scoped script and cannot select or create
named scripts; it reads and writes the one script the JMAP Sieve extension hands it
(`getSieveScript` / `createSieveScript` / `updateSieveScript`). There is no way for a user
to edit a non-active script from the UI, so the user-owned half would be unreachable.

So admin content and user content are forced to share one script. The reconciler has to
become a merge, not a replace.

## What makes the merge safe

Bulwark's round-trip behaviour, from its source and confirmed by the surviving
`include` in the 2026-09-14 screenshot:

- Sieve it cannot model is classified as an **External rule** and preserved unchanged
  (`lib/sieve/parser.ts`).
- Comments outside Bulwark's own metadata region are preserved.
- Existing `require` statements are kept intact and hoisted below the metadata block,
  before generated rules — the generator never moves or removes them
  (`lib/sieve/generator.ts`).
- If the whole script is unrecognisable, `isOpaque` disables the visual builder rather
  than discarding content.

Marker comments therefore survive a Bulwark save, which is what a region-replace merge
needs.

## Design

Delimit the admin content with marker comments and replace **only** that region:

```sieve
# >>> BEGIN stalwart-sieve-reconcile managed block -- do not edit <<<
require ["include"];
include :global "archive-all";
# >>> END stalwart-sieve-reconcile managed block <<<
```

Per-account decision table, replacing the current `reconcile()`:

| Active script state | Action |
| --- | --- |
| no active script | install marked block as `SCRIPT_NAME`, activate → `installed` |
| active script contains `BEGIN` marker | replace marker region with git's block, preserve every other byte → `updated` / `ok` |
| active is `SCRIPT_NAME`, no markers, body normalises equal to the legacy two-liner | rewrite as marked block → `migrated` |
| active is `SCRIPT_NAME`, no markers, body differs | **skip and report** — this is the case that ate the rules |
| active has another name, no markers | skip and report (unchanged behaviour) |

The fourth row is the behavioural fix: absent markers, an unfamiliar body is now treated as
someone else's work rather than as drift.

### Backup before any write

Today's data loss had no backup to fall back on. Before any `PUTSCRIPT` to the active
script, print the current body to stdout so it lands in the job log.

A second Sieve script named `<SCRIPT_NAME>-backup` was considered and rejected: Bulwark
manages "the" account script and cannot select among names, so a second script risks the UI
editing the wrong one. Storing it would also be a one-way door — `automation` holds
`sieveList/Get/Put/SetActive` but **not** `sieveDeleteScript`
(`stalwart-config-as-code/plan.md:338`), so a stray backup script could never be removed by
the job.

Log retention is `successfulJobsHistoryLimit: 3`, so this covers the last three runs —
enough for a next-morning "it ate my rules again" recovery, which is the scenario that
actually occurred.

### Duplicate-include detection

If Bulwark ever relocates the `include` out of the marker region, a region-replace would
reinstate it and leave two. Two identical `fileinto` calls to the same mailbox are a no-op
per RFC 5228, so this is cosmetic rather than harmful, but it should be reported: count
occurrences of `include :global "archive-all"` outside the managed region and flag them.

### Ordering

`archive-all` is `if spamtest >= 5 { addflag "$Junk"; fileinto "Junk"; } else { fileinto
:copy :specialuse "\\Archive" :create "Archive"; }`.

The ham branch uses `:copy`, which leaves the implicit keep intact — so a later user rule
doing a plain `fileinto` cancels the implicit keep and moves mail out of the Inbox while
the Archive copy survives. That is the behaviour a user expects from a filing rule.

The one hazard is a user rule containing `stop` that runs *before* the managed block: it
would skip both archiving and spam filing. Install the managed block at the top of the
script so it runs first. Note that this cannot be enforced after the fact — Bulwark owns
layout on save — so it is a default, not a guarantee.

The spam-equality caveat in `archive-all`'s own comment (Stalwart's native filing at
`ingest.rs:357` is guarded by `mailbox_ids == [INBOX_ID]`, which any `fileinto` breaks)
does not apply to user rules running afterward: the managed block already files spam
explicitly, so nothing downstream depends on that native path.

### Failure mode

Stalwart validates Sieve on `PUTSCRIPT` (`stalwart-config-as-code/plan.md:255`). A merge
that produced invalid Sieve is rejected server-side, leaving the stored script untouched,
and the job reports the error for that account while continuing with the rest. Delivery
cannot be broken by a bad merge — only by a merge that is valid and wrong, which the
rolling backup covers.

## Making a skip loud

Refusing to overwrite is correct, but it converts loud data loss into a silent gap: that
mailbox stops getting an archive copy, and nothing in the mail client looks wrong until
something is already gone. A line in a CronJob log that runs at 04:43 will not be read.

So a skipped or errored account is logged at ERROR with a fixed phrase:

```
ERROR sieve-reconcile: archive rule not applied: <address>: <detail>
```

One line per affected account, so the counter measures accounts-not-archiving rather than
runs-that-had-a-problem. Then, following the existing pattern for every other Loki-derived
signal here:

1. `alloy/helmrelease.yaml` — a `stage.match` on that phrase feeding a
   `metric.counter` named `stalwart_sieve_unmanaged_total`.
2. `prometheus/helmrelease.yaml` — alert `StalwartSieveArchiveRuleMissing` in the
   existing `email-stalwart` group:
   `sum(increase(loki_process_custom_stalwart_sieve_unmanaged_total[26h])) > 0`,
   `severity: warning`, delivered by AlertManager to Telegram.

**Why 26h and not 1h.** The source is a daily CronJob. A 1h window sits at zero for 23 of
every 24 hours, so the alert would resolve and re-fire daily. A 26h window overlaps
consecutive runs and stays firing until a run reports the account clean.

**Why the exit status does not change.** A skip is a correct refusal. Making it non-zero
would leave the CronJob permanently `Failed` for as long as one account has hand-written
rules — noise that trains the operator to ignore it. The alert is the signal.

**The phrase is an interface.** It is fixed in `sieve-reconcile.py` and matched in
`alloy/helmrelease.yaml`; changing the wording in one place silently disables the alert.
Both sides carry a comment saying so. Because the counter does not exist until the first
matching line, a broken selector is indistinguishable from a healthy cluster — so it must
be verified by forcing a skip, never by observing silence.

## Steps

1. Save this plan.
2. Rewrite `reconcile()` in `stalwart-config/sieve-reconcile.py` per the decision table;
   add `merge_managed()`, marker constants, backup, duplicate detection. Update the module
   docstring — its current safety claim is false.
3. Add the Alloy counter and the `StalwartSieveArchiveRuleMissing` alert; note in both
   repos' `AGENTS.md` that alert rules are always git-managed.
4. Commit and push so Flux reconciles the ConfigMap before 04:43.
5. Dry-run against the cluster (`SIEVE_DRY_RUN=1`) and confirm every account reports
   `would-migrate` or `ok`, nothing `skipped` unexpectedly. `stalwart-apply` runs the
   *deployed* ConfigMap, so this has to follow the push, not precede it.
6. Real run; confirm the managed block is in place and active.
7. Re-author the lost rules in Bulwark, run the job on demand, confirm the rules survive.
8. **Force a skip on a throwaway account** to prove the alert path end to end: counter
   appears in Prometheus, alert fires, Telegram message arrives. Silence proves nothing.
9. Write `summary.md`; update `docs/specs/handoff.md`.

## Verification

- `./scripts/stalwart-apply sieve-reconcile` with `SIEVE_DRY_RUN=1` — no writes, per-account
  outcome printed.
- After a real run with user rules present: the rules are still in the Bulwark UI, and the
  managed block is still present and active.
- Deliver a test message and confirm it lands in both Inbox and Archive, proving the
  managed block still executes alongside user rules.
- GTUBE message still files to `Junk`.

## Risks

- **Bulwark may reformat the marker region.** Mitigated by duplicate detection and by the
  fact that a lost marker degrades to "skip and report", not to a clobber.
- **A user rule with `stop` above the managed block silently disables archiving.** Not
  preventable from the reconciler. Detectable later by checking for `stop` before the
  managed region; out of scope for this change.
- **Rolling backup is one deep.** Two bad runs in a row lose the original. Acceptable given
  the job runs daily and the skip path is now the default for unrecognised bodies.

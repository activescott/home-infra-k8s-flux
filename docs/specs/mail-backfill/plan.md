# Phase 9 — backfill Gmail history and iCloud contacts into Stalwart

Stalwart has received `scott@willeke.com` mail since the Google Workspace dual-delivery routing
rule went in on 2026-08-29. The store held **2.6 MB** when this was written — one day of mail.
Everything before that date lives only in Google Workspace, and contacts live only in iCloud.

This phase loads the historical Gmail archive and calendar into Stalwart, and imports contacts
from iCloud. Google Workspace remains MX and keeps its independent copy throughout, so this is
purely additive and is not a cutover. Design context: [`../email-infrastructure/plan.md`](../email-infrastructure/plan.md).

## `vandelay import imap` is the wrong tool here, and three docs said otherwise

Until 2026-08-30 the plan of record — in `scott-todo.md`, `google-workspace-routing.md` and
`opnsense-mail-firewall.md` in the private repo — named `vandelay import imap`. That is wrong for
a Gmail source, and the reason is not a preference:

`vandelay`'s IMAP importer inserts **one row per `(folder, uid)`**
(`src/sync/import_imap/coordinator.rs`), and Stalwart suppresses duplicates only on SMTP ingest —
`crates/email/src/message/ingest.rs` gates dedupe behind `source.is_smtp()`. Gmail exposes every
label as an IMAP folder plus `[Gmail]/All Mail`, so a message carrying Inbox + All Mail + three
labels arrives as **five separate messages**.

The Takeout importer instead keys on `blake3` of the message bytes and, on a repeat hit, _updates_
the existing row's `mailbox_ids` rather than inserting (`src/sync/import_takeout/mail.rs`). One
message, several mailboxes — the model Gmail actually uses.

Two further reasons the IMAP path is unattractive here: Google Workspace ended password-only IMAP
on [2025-05-01](https://support.google.com/a/answer/14114704), leaving OAuth as the only supported
mechanism; and Google throttles IMAP downloads at roughly 2,500 MB/day.

**IMAP import is still right for a different job.** A Takeout export is a point-in-time snapshot,
so it cannot recover a _future_ delivery gap (a firewall drop, or Stalwart down). For that,
`vandelay import imap` remains correct: over a few days, per-label duplication is a cheaper
problem than the missing mail, and `vandelay export` matches on content identity so the overlap
with already-delivered messages is skipped.

## How vandelay works, and what that implies

Two decoupled stages. `import <source>` reads a source account into a local **SQLite archive**;
`export` pushes that archive into a **JMAP target**. JMAP is the only write path — there is no
IMAP-APPEND export. Neither `vandelay` nor `stalwart-cli` ships in the server image (the only
binary there is `/usr/local/bin/stalwart`, which is a whole-store dump/restore tool, not a mail
importer), so vandelay runs on a workstation.

**No import path runs Sieve.** `Email/import` resolves to `IngestSource::Jmap`, where `is_spam` is
hard-`false` and the Sieve ingest path is never entered — that path is reached only from SMTP/LMTP
local delivery. So the `archive-all` script does **not** touch imported mail; it lands exactly in
the mailboxes named and nowhere else.

**Decision: imported mail keeps its Gmail placement.** Inbox stays Inbox, archived stays Archive,
labels become folders. Historical Inbox mail is therefore _not_ also in Archive, so deleting it
from a client destroys the Stalwart copy. Accepted because Google Workspace retains an independent
copy of all of it. The alternative — a post-import `Email/set` pass adding Archive to every
non-Junk message — was considered and declined as tooling that has to be written and then trusted.

Fidelity that _is_ preserved: INTERNALDATE → `receivedAt`; `\Seen`/`\Flagged`/`\Answered`/`\Draft`
→ `$seen`/`$flagged`/`$answered`/`$draft`; custom keywords verbatim.

## Approach

Two archives, one target account. Two rather than one because an archive records its source
account, and mixing Google and Apple sources would need `--allow-source-change` for no benefit.

```
Google Takeout (Mail + Calendar)  ──> google.sqlite   ──┐
                                                        ├─> JMAP export ──> scott@willeke.com
iCloud CardDAV (contacts)         ──> icloud.sqlite   ──┘        via kubectl port-forward
```

**Export goes through `kubectl port-forward`, not the public hostname.** Stalwart's bans are
permanent by default — `authBanPeriod`, `scanBanPeriod`, `abuseBanPeriod` and `loiterBanPeriod`
are all unset, so a mistyped password retried is an indefinite ban, and only the pod CIDR is
allow-listed. A port-forward arrives as loopback, which is always allowed. It also avoids WAN
hairpin and keeps a multi-GB upload off the internet path.

**`--prune` is prohibited in every invocation.** It deletes target objects absent from the
archive — which is every message dual-delivery has landed since 2026-08-29.

Risk ladder: contacts first (smallest, and it proves the whole export path), then calendar, then
mail. Each stage verifies before the next begins.

## Prerequisites

Manual steps, collected so none surfaces mid-import.

| #   | Step                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Request the **Google Takeout** export — settings below. Google takes hours to days to build it.                           |
| 2   | Mint an **iCloud app-specific password** at appleid.apple.com. iCloud DAV cannot do interactive 2FA, so this is required. |
| 3   | Have a **Stalwart app password** for `scott@willeke.com` to hand (self-service in the Stalwart UI).                       |
| 4   | **ZFS snapshot of `thedatapool/app-data` before the mail export**, so a bad import is one rollback rather than a repair.  |
| 5   | Confirm workstation free space exceeds the Takeout size — the archive, the expanded tree, and the SQLite file coexist.    |

### Takeout settings

Select **Mail** and **Calendar** only.

- **Mail**: format **MBOX**, not JSON. Vandelay's Takeout importer parses mbox `From ` separators
  and reads `X-Gmail-Labels` off each message; it has no Gmail-JSON parser, so a JSON export
  imports zero mail. Leave all labels checked — Spam and Trash are included deliberately, see
  below.
- **Calendar**: all calendars. ICS, no alternative offered.
- Delivery: export once, file type **.tgz** (avoids zip64 edge cases in macOS Archive Utility on
  multi-GB archives), file size **10 GB**. Takeout splits one logical archive across several
  files and they must all be extracted into a **single merged directory** before vandelay sees a
  coherent tree; 10 GB balances part count against the cost of a failed download.

**The Google account language must be English when the export is built.** Vandelay's label→role
mapping matches English tokens only (`Inbox`, `Sent`, `Drafts`, `Trash`, `Spam`, `Archived`) and
only at the top level — `if canonical_path.contains('/') { return None }`. A localized export
would scatter system mail into custom folders. `Category Personal|Promotions|Social|Updates|Forums`
are dropped by design.

**Spam and Trash are included, and that has one irreversible consequence.** Vandelay sets
`train_classifier` when imported keywords contain `$junk`/`$notjunk` or the target mailbox is
Junk, and Stalwart's ingest then feeds its Bayes classifier. Importing Gmail Spam trains the model
on a real spam corpus — desirable, but it is a write that a store rollback does **not** undo.

### Tooling

`brew install stalwartlabs/tap/vandelay`. Require **≥ 1.0.9**: 1.0.8 dropped emails whose
`receivedAt` failed to parse, and CalDAV discovery against `501`-answering servers was broken
before it. Installed 2026-08-30 at **1.0.10**.

`--objects` takes a comma-separated list and `--help` does not enumerate the valid tokens, so they
were probed against the binary directly — an invalid one fails fast with
`usage error: unknown object type: <name>` before any connection is attempted. **Verified valid:**
`mailbox`, `email`, `calendar`, `calendarevent`, `addressbook`, `contactcard`. Omitting `--objects`
exports everything present in the archive, which is exactly what the staged approach below avoids.

## Steps

### 1. Contacts — iCloud CardDAV

Smallest payload, and it proves the JMAP export path end to end before any mail moves.

```bash
mkdir -p ~/mail-backfill && cd ~/mail-backfill

read -rs VANDELAY_PASSWORD && export VANDELAY_PASSWORD   # iCloud app-specific password
vandelay import carddav --url https://contacts.icloud.com/ \
  --auth-basic <apple-id> icloud.sqlite

vandelay inspect icloud.sqlite addressbook
vandelay inspect icloud.sqlite contactcard
```

In a second terminal:

```bash
kubectl --context nas -n email-stalwart port-forward svc/stalwart-admin 8080:8080
```

```bash
read -rs VANDELAY_PASSWORD && export VANDELAY_PASSWORD   # Stalwart app password
vandelay export --url http://localhost:8080 \
  --auth-basic scott@willeke.com --account-name scott@willeke.com \
  --dry-run icloud.sqlite
# review counts, then rerun without --dry-run
```

Verify in Bulwark that contacts appear and the count matches `inspect`. iCloud groups are
`X-ADDRESSBOOKSERVER-KIND:group` vCards; whether they survive the vCard→JSContact→vCard round trip
is **unverified** — check specifically and record the answer either way.

### 2. Calendar — from the same Takeout

`vandelay import takeout` scans the directory tree **recursively** for `.mbox`, `.ics` and `.vcf`
files, so one import populates the archive with mail and calendar together and the extracted
Takeout parts can simply be merged into one directory without rearranging them.

`import takeout` supports `--dry-run` as well, which reports the full plan without writing — worth
running first on a multi-GB tree to see the label→mailbox mapping before committing to it.

```bash
vandelay import takeout --dry-run ~/mail-backfill/takeout/ google.sqlite
vandelay import takeout ~/mail-backfill/takeout/ google.sqlite
vandelay inspect google.sqlite calendar
vandelay inspect google.sqlite calendarevent
vandelay inspect google.sqlite mailbox      # sanity-check the label→mailbox mapping now
```

Export calendar objects only first, so a mail problem and a calendar problem cannot arrive
together:

```bash
vandelay export --url http://localhost:8080 \
  --auth-basic scott@willeke.com --account-name scott@willeke.com \
  --objects calendar,calendarevent google.sqlite
```

Why vandelay rather than a script that PUTs the ICS: Stalwart's CalDAV `PUT` rejects a resource
containing more than one UID — `crates/dav/src/calendar/update.rs` returns _"iCalendar must
contain exactly one UID and same component types"_ — so a Google Calendar export cannot be sent as
one object. Splitting it correctly means keeping `RECURRENCE-ID` overrides with their parent UID
and carrying `VTIMEZONE`s into each chunk. Vandelay already does this.

Verify in Bulwark and on the phone (the CalDAV account from the Apple configuration profile): a
recurring event, an all-day event, and an event in a non-local timezone.

### 3. Mail

Take the ZFS snapshot first.

```bash
vandelay export --url http://localhost:8080 \
  --auth-basic scott@willeke.com --account-name scott@willeke.com \
  --objects mailbox,email --dry-run google.sqlite
```

**The dry run is the dedupe gate, not a formality.** `export` is stateless and matches against the
target by content-derived identity (message-id + from + subject + sentAt + to hash), which is the
only thing preventing the overlap with dual-delivered mail from duplicating. Compare its count
against `inspect`'s. If nothing is reported as skipped, **stop** — proceed only by excluding the
overlapping date range.

Then run for real, watching:

```bash
kubectl --context nas -n email-stalwart exec stalwart-0 -- df -h /var/lib/stalwart
kubectl --context nas -n email-stalwart exec stalwart-0 -- du -sh /var/lib/stalwart
kubectl --context nas -n email-stalwart get pod stalwart-0 -w
```

Node memory is the real exposure: the Stalwart container has **no memory limit and no requests**,
so runaway usage shows up as node pressure rather than an OOM kill of the pod.

Alerts plausible during the run, to be read as expected rather than as new faults:
`StalwartAuthFailures` (>20/h) if a password is wrong, and `StalwartPodRestarted`.
`StalwartQueueBacklog` should stay quiet — JMAP import does not enqueue. There is **no disk-usage
alert** on the PV, which is why the `df` check is manual; `thedatapool` had 4.1 TB free (6% used)
when this was written, so it is a formality.

`stalwart-sieve-reconcile` runs daily at 04:43 and touches every account. Harmless here — it only
sets the active script — but avoid overlapping the export with it.

## Durability

Per [`docs/durability`](../email-infrastructure/plan.md) practice for this work.

- **Writes user data?** Yes — the largest single write to the mail store so far.
- **Worst loss?** A bad import corrupting or duplicating the store. Bounded twice: Google
  Workspace and iCloud both retain independent copies of everything being imported, and the
  pre-import ZFS snapshot makes the store itself recoverable.
- **Irreversible step?** One, named above: importing Gmail Spam trains the Bayes classifier, and a
  store rollback does not undo that.
- **Backup path.** `/mnt/thedatapool/app-data/stalwart/prod/data` is already inside the B2
  allowlist (`/app-data/**`) and the sanoid schedule — no include-list change. B2 runs weekly
  (Mon 00:00), so the first offsite copy of the backfill may be up to seven days out; the ZFS
  snapshot is the near-term protection.
- **`--prune` is prohibited.**

## Verification

- **Contacts**: Bulwark count matches `vandelay inspect … contactcard`; group handling checked
  explicitly rather than assumed.
- **Calendar**: recurring, all-day, and foreign-timezone events each render correctly in Bulwark
  _and_ in iOS Calendar via the existing CalDAV profile.
- **Dedupe**: the mail dry run reports skips across the dual-delivery overlap window. A gate.
- **Mail fidelity**, spot-checked against Gmail on specific known messages: a multi-label message
  appears **once** with several mailboxes, not once per label; read/unread and starred state
  match; the message date is the original, not the import date.
- **Placement**: an archived-in-Gmail message is in Archive and not in Inbox; an Inbox message is
  in Inbox. Confirms the placement decision actually took effect.
- **Nothing regressed**: send a test message to `scott@willeke.com` after the import and confirm it
  lands in **both** Inbox and Archive — i.e. `archive-all` still runs for newly delivered mail,
  which the import bypassed but must not have disturbed.
- **Store growth** proportionate to the Takeout size, via `du -sh`.

## Out of scope

- Backups rework — deferred, and needs its own plan and a discussion first.
- Cutting `willeke.com`'s MX away from Google. Dual delivery stays the terminal state.
- Archive back-tagging of imported history, considered and declined above.

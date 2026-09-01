# Phase 9 — backfill outcome

Running log. Plan: [`plan.md`](./plan.md). Updated as each stage lands.

| Stage              | State                | Date       |
| ------------------ | -------------------- | ---------- |
| 9a persist/correct | done                 | 2026-08-30 |
| 9b prerequisites   | done                 | 2026-08-31 |
| 9c contacts        | **done**             | 2026-08-31 |
| 9d calendar        | **done**             | 2026-08-31 |
| 9e mail            | **done**             | 2026-08-31 |
| 9f record          | **done** (this file) | 2026-09-01 |

Calendar confirmed good by Scott on 2026-08-31.

**Phase 9 is complete. 197,978 messages, 2007-11-07 to 2026-08-30, `failed=0`**, plus 542
contacts and the calendar. Every verification the plan called for has evidence, including the
last one — that `archive-all` still files newly delivered mail to Inbox _and_ Archive, proven
2026-09-01 and written up under 9e.

Nothing is outstanding. Both import credentials were revoked and `~/mail-backfill` (52 GB) was
deleted on 2026-09-01; the scripts worth keeping moved to [`scripts/`](./scripts/) first.

## 9c. Contacts — iCloud CardDAV, done 2026-08-31

**1 address book, 542 contact cards**, imported and exported with `failed=0` at every step.

```
import  addressbook  created=1  fetched=0   failed=0
import  contactcard  created=0  fetched=542 failed=0
export  AddressBook  created=1  failed=0
export  ContactCard  created=542 failed=0
```

Verified by **re-running the export as a dry run afterwards**, which reads the target back:
`AddressBook 0 create / 1 matched`, `ContactCard 0 create / 542 matched`. That is a server-side
readback, not the tool restating its own write, and it independently confirms export's
content-identity matching works — the property Phase 9e depends on for dedupe.

The Apple ID was read from the Mac's own iCloud account
(`defaults read MobileMeAccounts`) rather than guessed. A wrong username against iCloud costs
repeated failed auths.

### Fidelity: the original vCard is retained alongside the JSContact

Every one of the 542 rows carries a `vCard` key holding the source vCard verbatim, next to the
converted JSContact fields. So a lossy vCard→JSContact mapping is recoverable from the archive
rather than a one-way loss. Field presence across the 542:

| Field            | Cards |
| ---------------- | ----- |
| `name`           | 542   |
| `phones`         | 434   |
| `organizations`  | 295   |
| `emails`         | 295   |
| `notes`          | 146   |
| `addresses`      | 141   |
| `links`          | 92    |
| `media`          | 73    |
| `onlineServices` | 59    |
| `nicknames`      | 55    |
| `anniversaries`  | 24    |
| `titles`         | 12    |
| `calendars`      | 1     |

### The groups question is _unanswered_, not answered

The plan flagged iCloud groups (`X-ADDRESSBOOKSERVER-KIND:group`) as an unverified round-trip
risk and asked for the answer either way. The answer is that **this account has no user-defined
groups, so nothing exercised the path.**

Evidence, since "no groups in the archive" alone would not distinguish _absent_ from _dropped_:

- The CardDAV collection reported **542 items** and the archive holds **542 cards** — an exact
  match, so nothing was discarded in between.
- The Mac's local Contacts store has four sources; the one with 542 contacts is the iCloud one.
  Three of the four each report a single group record named `card` — the same name in every
  source, including ones with unrelated contact counts, which makes it an internal artifact
  rather than a user group.

If groups are ever created in iCloud, this is still untested. Do not read this as a pass.

### The port-forward does not do what the plan said it does

The plan routed the export through `kubectl port-forward` for three stated reasons: loopback
arrival (immune to Stalwart's permanent bans), no WAN hairpin, and keeping a multi-GB upload off
the internet path. **None of them hold.** vandelay warns:

```
warning: session advertises apiUrl, uploadUrl, downloadUrl on https://mail.activescott.com
(connected to http://localhost:8080); vandelay must use the advertised URL.
```

A JMAP client must follow the session object's advertised URLs, so only the initial session
fetch goes to `localhost:8080`; every subsequent write goes to `https://mail.activescott.com`.

**Decided 2026-08-31: accept the public path for every stage, mail included.** The hairpin stays
on the LAN and the firewall handles it at local speed, so ~8 GB over that route is not worth
temporarily rewriting Stalwart's advertised HTTP URL to avoid. The port-forward is kept only
because it is how the session URL gets bootstrapped.

The ban hazard that originally motivated the port-forward is _not_ a live concern on either path
anyway: traffic arriving via Traefik comes from the allow-listed `172.16.0.0/16` pod CIDR.

What remains true and worth keeping written down: **the mitigation the plan described was never
in effect.** If a future task depends on export traffic actually staying on loopback, the
advertised URL is the thing to change — the port-forward alone will not do it.

## 9d. Calendar — from the Takeout `.ics`, done 2026-08-31

Source: one `Takeout/Calendar/*.ics`, 3.87 MB, a single `VCALENDAR` holding 3,477 `VEVENT`
blocks. That single-blob shape is exactly what Stalwart's DAV `PUT` refuses ("iCalendar must
contain exactly one UID"), which is why vandelay's UID-keyed splitting is the tool rather than a
script.

**2,961 of 2,963 events on the server**, plus one new event created deliberately (below).

```
import  calendar      created=1     failed=0
import  calendarevent created=2963  updated=7  failed=0
export  Calendar      created=1     failed=0
export  CalendarEvent created=2960  failed=3
```

Reconciliation against the source, which closes exactly:

| Quantity                                    | Count |
| ------------------------------------------- | ----- |
| `VEVENT` blocks in the `.ics`               | 3,477 |
| distinct event UIDs                         | 2,963 |
| archive rows                                | 2,963 |
| `RECURRENCE-ID` blocks                      | 536   |
| …folded into masters' `recurrenceOverrides` | 514   |
| …stored as standalone rows (`recurrenceId`) | 22    |
| event `RRULE`s (excludes 4 in `VTIMEZONE`)  | 402   |
| rows with `recurrenceRule`                  | 401   |

As with contacts, **every row retains its source `iCalendar` verbatim**, so any conversion gap
is recoverable from the archive rather than lost.

### Counting `VALARM` UIDs as event UIDs invents a 306-event data loss

A first pass compared `grep '^UID:'` output against the archive and reported **306 missing
events**. There were none. The `.ics` carries 306 distinct `UID` lines _inside `VALARM`
blocks_ — Apple/Google write both `UID` and `X-WR-ALARMUID` on alarms — and a UID grep that
does not track component nesting counts them as events.

Two other ways the shell approach produced wrong numbers before that:

- **Line folding.** RFC 5545 folds at 75 octets; 111 `UID` lines here are folded, so `^UID:`
  truncates them. Unfold first: `perl -0pe 's/\r?\n[ \t]//g'`.
- **`length()` on an array is a gawk extension.** macOS ships BWK awk, where the classifier
  silently under-reported.

The reliable check is a parser that tracks `BEGIN`/`END` nesting and skips `VALARM`:
[`scripts/collide.py`](./scripts/collide.py) does this and returns 2,963 distinct UIDs against
2,963 archive rows.

Generalisable: **when a count mismatch appears, verify the measurement before reporting the
finding.** Three separate shell techniques each produced a plausible, wrong number here.

### One `RRULE` did not convert — valid input, vandelay gap

```
RRULE:FREQ=MONTHLY;UNTIL=20220901;INTERVAL=1;BYMONTHDAY=2
```

on an event whose `DTSTART` is `VALUE=DATE`. RFC 5545 §3.3.10 _requires_ `UNTIL` to be a DATE
when `DTSTART` is a DATE, so the input is correct and vandelay dropped the rule. The event
imported; it lost only its monthly repeat, which expired 2022-09-01. Candidate for an upstream
report.

### Three events rejected by Stalwart on UID uniqueness

```
CalendarEvent c1350 / c1841: "An event with UID 017872A2-…F1345 already exists."
CalendarEvent c2538:         "An event with UID B8E15FEC-…AE5FD5 already exists."
```

Both cited UIDs are **`VALARM` UIDs that Google reused across several events** (3× and 2× in the
source). Neither string appears anywhere in the archive, so the conflict is raised server-side
against an identifier Stalwart derives from the alarm rather than from `$.uid`. The exact
derivation is **not** established — worth pinning down before assuming it cannot affect anything
larger.

The same three failed again on a later export **into an empty calendar**, which narrows it: the
collision is _within a single export run_, not against pre-existing server state. The first event
carrying a reused alarm UID is created; every later one presenting the same UID is rejected.

Scott declined two of them (duplicate "Family Meeting & Dinner" weekly series from 2020, the
usual artifact of re-creating rather than editing a recurrence). The third, a yearly all-day
"Wedding Anniversary", was replaced rather than repaired: the Takeout series started **2018**,
ten years after the actual date. A corrected row was inserted into the archive with a fresh
`uuidgen` UID, `start` `2008-10-11`, and `iCalendar`/`alerts` removed so nothing could carry the
colliding identifier, then exported — `created=1`.

### Consolidating onto one calendar — the default cannot be deleted

The import created a **second** calendar (`SW gCal`) alongside the account's stock
`Stalwart Calendar (scott@willeke.com)`. The obvious fix — delete the stock one, keep the
import — is not available:

```
DELETE /dav/cal/<account>/default/  →  403
<A:default-calendar-needed/>
```

So it had to go the other way: the **imported** collection is the disposable one, and its objects
belong in `default`.

What made that cheap is that vandelay's `sync_id_jmap` / `sync_state_jmap` tables are **empty** —
it is not pinned to the collection it created. It resolves the target calendar **by display
name**, so:

1. rename `default` to the archive's calendar name (`SW gCal`);
2. `DELETE` the imported collection, so its events stop matching by content;
3. re-export — `Calendar 0 create / 1 matched`, `CalendarEvent 2964 create / 0 matched`;
4. **rename `default` last**, to `Stalwart (scott@willeke.com)`.

Order matters: renaming before step 3 makes the name no longer match and vandelay creates a third
calendar. Nothing re-creates it afterwards, because 9e exports `--objects mailbox,email` and
never touches calendars.

Final state, read back from the server: **one calendar**,
`/dav/cal/scott%40willeke.com/default/` named `Stalwart (scott@willeke.com)`, holding
**2,961 events**, enumerating without a `507`. The outstanding 3 are the declined ones.

### `WebDav.maxResults` had to be raised before clients could see the calendar

2,961 events in one collection exceeded the stock DAV cap of 2000, so every enumeration came back
truncated with `507` + `<D:number-of-matches-within-limits/>`. Raised to **4000** in
`plan.ndjson` (`7ff6473`), applied, and Stalwart restarted — it builds configuration at startup,
so `apply` alone would not have taken effect.

Verified after: `Max Results: 4000`, and a `PROPFIND Depth: 1` returns 2,962 hrefs with **no**
truncation element. Detail and the failure mode it causes are in
[`stalwart-config/README.md`](../../../apps/production/email-stalwart/stalwart-config/README.md).

### Rate limiting is a real constraint for 9e

The export hit `HTTP 429` twice at ~3k objects, with
`ratelimit-policy="requests";q=1000` and `retry-after=57`. vandelay backed off 57s and retried
without loss. **Mail is ~15.5 GB and far more objects**, so expect this repeatedly and budget
wall-clock for it. It is not a fault and needs no intervention, but a run that appears hung is
probably in a 57-second backoff.

> **This paragraph was wrong for mail, and it cost time.** It describes the general
> `requests";q=1000` limiter. Mail first hits a _different_ one — a per-hour **blob upload**
> quota of 1,000 files / 50 MB whose `retry-after` is the remainder of the hour (755 s
> observed), not tens of seconds. Reading the note above, 9e was started against a 50 MB/hour
> cap with a 15.5 GB payload: a 310-hour run that `--max-retries 5` would have abandoned after
> about an hour. Both limiters, their measured throughput, and the values to use are in
> [`stalwart-config/README.md`](../../../apps/production/email-stalwart/stalwart-config/README.md).
> Do not generalise one Stalwart limiter's behaviour to another.

## 9e. Mail — from the Takeout mbox, done 2026-08-31

**197,978 messages, 2007-11-07 to 2026-08-30, `failed=0` at every step.** Server holds 198,051
(the difference is mail that arrived during the run plus messages that never had a Gmail twin).
Store: 267 G used of a 4.3 T pool.

```
import  mailbox c=34     f=0  |  email c=197978 u=0 f=0
export  Mailbox created=0     skipped=20     failed=0
export  Email   created=129627 skipped=68351 failed=0
```

The 68,351 skips are what earlier interrupted runs had already landed, matched rather than
duplicated.

### The import is one transaction — an interrupted run loses all of it

The first import was killed at ~14k messages processed. `emails` was left at **0**: vandelay
holds the whole mbox pass in a single transaction and commits at the end. There is no partial
progress and no checkpoint, so a laptop sleep or a tool timeout costs the entire pass (~35 min
for 15.5 GB). Run it detached (`nohup`) and hold the machine awake:

```bash
nohup vandelay import takeout -v ~/mail-backfill/takeout/ ~/mail-backfill/google.sqlite \
  > ~/mail-backfill/import-mail.log 2>&1 &
nohup caffeinate -ims -w "$!" >/dev/null 2>&1 &   # releases itself when the pid exits
```

The **export**, by contrast, is incremental and safe to interrupt — killed runs kept their work
and the next run matched past it.

### Two rate limiters, not one, and mail hits the undocumented one first

Detail and the values in
[`stalwart-config/README.md`](../../../apps/production/email-stalwart/stalwart-config/README.md).
In short: a per-hour **blob upload** quota (stock 1,000 files / 50 MB, `retry-after` = rest of
the hour) blocks a bulk import outright, and behind it `Http.rateLimitAuthenticated` (stock
1,000/min) throttles it to **36 MB/min ≈ 7 h**. Raised to 250,000 / 20 GB / 10,000-per-min the
same export ran at **350 MB/min ≈ 40 min with zero 429s**. Both were restored to stock
afterwards (`f157ab4`); both need `apply` **and** a `rollout restart` at each end.

### Gmail's IMAP-keyword labels became folders, and 18,025 messages had no label at all

Takeout's `X-Gmail-Labels` produced **34 mailboxes**, including `IMAP_$NotJunk` (56,444),
`IMAP_NotJunk` (13,635), `IMAP_$MailFlagBit0/1/2`, `IMAP_JunkRecorded`, `[Gmail]All Mail`,
`Muted`, `Chat` — IMAP keyword artifacts, not user labels — plus a fallback mailbox named after
the mbox file holding 18,025 messages that had no parseable label (2,876 with no header at all,
15,149 with an empty one). Note this contradicts the plan's expectation that `Category *` labels
are dropped: `Category Purchases` (5,925), `Travel`, and `Bills` all came through as real
folders.

**Deleting those 14 mailboxes was not an option: 44,852 messages had no other placement** and
would have been orphaned. Scott chose to remap them to Archive while recording the original
folder as a JMAP keyword — accepting that Apple Mail does not display arbitrary IMAP keywords,
so the provenance is visible in Bulwark and via JMAP but not on the phone.

[`scripts/remap-artifacts.sql`](./scripts/remap-artifacts.sql) does it in one transaction, with
[`scripts/remap-artifacts-check.sql`](./scripts/remap-artifacts-check.sql) run either side.
Result, every number as predicted:

| Invariant                 | Before  | After       |
| ------------------------- | ------- | ----------- |
| total emails              | 197,978 | 197,978     |
| emails with no mailbox    | 0       | 0           |
| distinct blobs referenced | 197,978 | 197,978     |
| mailboxes                 | 34      | **20**      |
| sync mailbox rows         | 34      | **20**      |
| emails carrying `gmail-*` | 0       | **76,345**  |
| emails in Archive         | 119,776 | **182,653** |

62,877 messages moved to Archive (their only placement was an artifact or the fallback — in
Gmail terms, "in All Mail with no label"); 13,468 kept a real label as well. Keywords are
`gmail-imap-$notjunk`, `gmail-nolabel`, `gmail-all-mail` and so on — `$` mid-keyword is legal
and Stalwart accepts it, which matters because `IMAP_$NotJunk` and `IMAP_NotJunk` are different
folders that a naive slug would collide.

Delete the artifact mailboxes' `sync_id_takeout` rows too, or the export re-creates them as
empty folders.

### 544 messages have two `Message-ID` headers — a re-run would duplicate them

The post-export readback dry run reports `Email 544 create / 197434 matched`, which looks like
544 messages failed to land. **They did land.** The archive splits exactly:

```
messages with 1 Message-ID header: 197,434   <- vandelay MATCHED 197,434
messages with 2 Message-ID headers:    544   <- vandelay CREATE    544
```

Such messages carry both `Message-ID:` and `Message-Id:` with different values. Stalwart indexes
one, vandelay's matcher reads the other, so it cannot re-match them. Verified end to end on
`100190-22013722232730397@componentsource.com`, which is on the server at its exact
`receivedAt` and subject under the _other_ id, `P624T736C918277@195.171.5.27`.

**Consequence: never re-run this export as-is — it would create 544 duplicates.**

### The overlap window keeps the server's placement, not Gmail's

Gmail had 52 messages in Inbox; the server shows 18. All 52 are present. 35 of them were
**skipped as already-delivered**, and vandelay does not rewrite a matched message's mailboxes,
so the server's own state wins:

| Where the 52 actually are  | Count |
| -------------------------- | ----- |
| Inbox (incl. combinations) | 17    |
| Archive only               | 26    |
| Trash + Archive            | 5     |
| Junk (incl. + Archive)     | 4     |

That is correct behaviour — the import must not un-delete or un-archive what Scott already
handled, nor un-junk what Stalwart's own filter caught. The same effect explains `micah`
1,704 → 1,702. Expect it for any dual-delivery overlap; it is not loss.

### Verifying "did everything land" — two traps

Comparing Message-ID sets between archive and server is the obvious check and it is easy to get
wrong twice:

- **`email.policy.default` truncates malformed Message-IDs.** A header like
  `<...@baeumken@reverse-software.de>` (two `@`) parses as an addr-spec and comes back as
  `...@baeumken`, while Stalwart keeps the raw string. This manufactured ~523 phantom
  "missing" messages. Extract the literal text between `<` and `>` from the raw bytes instead.
- **A regex needing a following header line misses the last header.** `(?=\r?\n[^ \t])` silently
  returned "no Message-ID" for 7,358 messages. Needs `|\Z`.

The tell in both cases was the _reverse_ diff: roughly as many ids "extra" on the server as
"missing" from it is a normalization disagreement, not data loss. Always compute both
directions. [`scripts/raw_mids.py`](./scripts/raw_mids.py) has the working extractor, and
[`scripts/dump_server_mids.sh`](./scripts/dump_server_mids.sh) the server-side dump to diff it
against.

Also: **`Email/query` `filter.header` does not resolve Message-Id on this server** — it returns
an empty `ids` with no error, so it cannot be used for existence checks. Page by `receivedAt`
window instead. And paging by `position` over a live collection can skip or repeat rows.

### Fidelity spot-checks (all verified on the server, not from the tool's own report)

- A message in Archive + `filtered` + `Category Purchases` is **one** message with three
  mailboxes, not three copies.
- `$seen`, `$important`, `$flagged` preserved; `receivedAt` is the original date (oldest
  verified: 2007-12-10), not the import date.
- `gmail-nolabel` = 18,025 and `gmail-imap-$notjunk` = 56,444 on the server, matching the
  archive exactly.
- 127 `Opened`+`Unread` label conflicts resolved to `$seen`, logged by vandelay as warnings.

### `archive-all`'s ham branch, verified post-backfill 2026-09-01

The backfill went in entirely through JMAP `Email/import`, which never enters the Sieve ingest
path, so nothing about the 197,978 imported messages says whether newly _delivered_ mail still
gets its archive copy. Proven separately with an external test message:

```
message-ingest.ham  from = "activescott@me.com", to = ["scott@willeke.com"]
                    documentId = 198132, mailboxId = [5, 0]
```

and read back over JMAP, which is the part that matters — one document in two mailboxes, not
two copies:

```json
{
  "subject": "Close out Phase 9 properly",
  "receivedAt": "2026-09-01T22:15:37Z",
  "mailboxIds": { "f": true, "a": true }
}
```

`a` is the `inbox`-role mailbox and `f` the `archive`-role one. The spam branch was already
confirmed live (`message-ingest.spam`, `mailboxId = [2]` = Junk, no archive copy), so both
branches now have evidence.

Send the test **from an external address**. A message sent from `scott@willeke.com` itself
leaves via `google-willeke-com-relay` and loops back through the relay-guard path, which tests
something else. It must also be ordinary ham — `spamtest >= 5` files it to Junk with no archive
copy, which is the branch that was already proven.

**Numeric mailbox ids in the ingest log are not stable.** The `archive-all` script's own comment
records `mailboxId = [9, 0]` from the pre-backfill verification; Archive is `5` now, because
deleting the 14 artifact mailboxes renumbered them. Resolve ids through `Mailbox/get`'s `role`
field rather than trusting a number written down earlier. Post-backfill state:

| Mailbox | JMAP id | Role      | Messages |
| ------- | ------- | --------- | -------- |
| Inbox   | `a`     | `inbox`   | 39       |
| Archive | `f`     | `archive` | 182,791  |
| Sent    | `e`     | `sent`    | 14,429   |
| Junk    | `c`     | `junk`    | 308      |
| Trash   | `b`     | `trash`   | 67       |

Twenty mailboxes total; the other fifteen are Gmail labels that survived the remap.

### JMAP over `port-forward`: use `/jmap/session`, not `/.well-known/jmap`

The well-known path answers **307** over plain HTTP and `curl` without `-L` returns an empty
body, so session discovery silently yields an empty `apiUrl` and every later call fails with a
misleading `curl: option : blank argument`. Go straight to `http://localhost:8080/jmap/session`
and post method calls to `http://localhost:8080/jmap`. Do not add `-L` to chase the redirect —
it points at the public HTTPS hostname and defeats the point of the tunnel.

## Credentials — both revoked 2026-09-01

Both Phase 9 credentials are **revoked**, and the `0600` files that held them
(`~/mail-backfill/.stalwart-pw`, `.icloud-pw`) are deleted. Neither lived in git or in a sops
secret — both were minted in their vendor's own UI, so revoking changed no file and rolled no
pod.

- **iCloud app-specific password** — its only consumer was the 9c contacts import.
- **Stalwart app password** for `vandelay export` — used once more on 2026-09-01 for the
  `archive-all` readback, then revoked. It had to be **rotated rather than left to expire**
  on 2026-09-12: during 9e it was disclosed in a session transcript, because a `curl -w
"%{url_effective}"` prints the effective URL and basic-auth credentials are part of that URL.
  It was scoped to `scott@willeke.com` and every endpoint it reached is public.

  **Avoid `%{url_effective}`, `%{redirect_url}` and `-v` on any authenticated `curl`.** Use
  `%{http_code}` alone. Read secrets as `$(cat <file>)` so the value stays out of shell history
  too.

## `~/mail-backfill` — deleted 2026-09-01

**52 GB**, removed once Phase 9 closed: the 15.53 GB expanded mbox under `takeout/`,
`google.sqlite` (15.8 GB), and two backups (`google-preremap-backup.sqlite` 15.8 GB,
`google-precal-backup-20260831.sqlite` 8.9 MB). Regenerable — request Takeout again and mint new
app passwords — so it was not worth 52 GB of disk to hold.

The working scripts were moved into [`scripts/`](./scripts/) next to this file first, since they
lived only in that directory and are the non-obvious part:

| Script                      | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `remap-artifacts.sql`       | The artifact→Archive remap, one transaction, with the count guard |
| `remap-artifacts-check.sql` | Before/after invariants; run either side of the remap             |
| `raw_mids.py`               | Message-ID extractor that avoids both traps described above       |
| `dump_server_mids.sh`       | Pages `Email/query` + `Email/get` to dump every server Message-ID |
| `collide.py`                | `.ics` UID parser that tracks nesting and skips `VALARM`          |

Each carries a path or id from that run and needs adjusting before reuse: the two Python scripts
hardcode `DB = "/Users/scott/mail-backfill/google.sqlite"`, and `dump_server_mids.sh` hardcodes
`accountId`. It now reads its credential from `STALWART_PW_FILE` rather than the deleted
`~/mail-backfill/.stalwart-pw`.

The commands quoted earlier in this file still name `~/mail-backfill` paths. They are the
historical record of the run; a fresh backfill recreates that directory.

The real rollback path was never this directory anyway: it is the pre-mail ZFS snapshot
`thedatapool/app-data@pre-mail-backfill-20260831`. Recovery is **not** `zfs rollback` — that
dataset holds every app — so mount it under `.zfs/snapshot/` and copy the Stalwart directory
back.

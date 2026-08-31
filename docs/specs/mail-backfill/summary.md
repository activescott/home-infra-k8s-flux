# Phase 9 — backfill outcome

Running log. Plan: [`plan.md`](./plan.md). Updated as each stage lands.

| Stage              | State                   | Date       |
| ------------------ | ----------------------- | ---------- |
| 9a persist/correct | done                    | 2026-08-30 |
| 9b prerequisites   | done                    | 2026-08-31 |
| 9c contacts        | **done**                | 2026-08-31 |
| 9d calendar        | **done**                | 2026-08-31 |
| 9e mail            | not started             |            |
| 9f record          | in progress (this file) |            |

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
`scratchpad/collide.py` in the session dir does this and returns 2,963 distinct UIDs against
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

## Credentials to revoke when Phase 9 closes

- **iCloud app-specific password** — its only consumer was the 9c import above. Revoke at
  appleid.apple.com now; nothing later in Phase 9 uses it.
- **Stalwart app password** for `vandelay export` — still needed for 9d and 9e. It expires
  **2026-09-12**, which is a hard deadline on the mail export. Must be a separate credential
  from the one the mail client uses, or revoking it breaks Apple Mail.

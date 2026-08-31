# Declarative Stalwart configuration

`plan.ndjson` is applied by `stalwart-cli` from a Job in this namespace. Design and
rationale: [`docs/specs/stalwart-config-as-code/plan.md`](../../../../docs/specs/stalwart-config-as-code/plan.md).

```bash
./scripts/stalwart-apply plan                      # dry run, sends nothing
./scripts/stalwart-apply apply                     # config, via the API key
./scripts/stalwart-apply sieve-reconcile           # sync every account's Sieve script
./scripts/stalwart-apply snapshot <Object> [...]   # derive plan JSON from live state
./scripts/stalwart-apply query <Object> --fields name,...
./scripts/stalwart-apply cli <any-subcommand>      # escape hatch

# Fresh server only, before an API key can exist:
./scripts/stalwart-apply bootstrap                 # accounts, recovery-admin auth
./scripts/stalwart-apply apply-recovery            # config, recovery-admin auth
STALWART_APPLY_SECRET=stalwart-bootstrap-creds ./scripts/stalwart-apply query Account
```

`plan` and `apply` run whatever plan is **deployed**, not what is in your working tree.
Commit and let Flux reconcile first.

## Rebuilding this server from scratch

Runbook: [`docs/specs/stalwart-config-as-code/plan.md`](../../../../docs/specs/stalwart-config-as-code/plan.md).
Done once, on 2026-08-30, and the resulting server snapshot-diffed against the pre-rebuild
one at 11 object types, 11 identical, 0 differ.

The chicken-and-egg to remember: an API key is a credential **on an account**, so a fresh
store has no way to mint one. The first two applies authenticate as the recovery admin
(`bootstrap`, then `apply-recovery`); everything after that uses the key.

What never survives, by design: **API key secrets** (server-generated, unreadable) and
**passwords** (write-only). Both are re-set by hand afterwards.

## Only deltas from Stalwart's defaults belong here

A fresh Stalwart seeds its own defaults at first boot. This plan declares **only what we
deliberately differ on**, so it stays a statement of intent rather than a mirror of the
server — and so it does not fight upstream if their defaults change in a future version.
A rebuild is therefore: install, let it seed, then apply this.

Do not add an object just because it exists. `local`, `remote` and `dsn` are stock and are
deliberately absent.

## Why the `report` entries are here

The `report` **delivery schedule** is a genuine delta, twice over:

1. It went **missing** from this instance. v0.16.19 does seed it, and the seeding guard is
   all-or-nothing across virtual queues and delivery schedules, so nothing could have
   topped it up later — yet the virtual queue existed and the schedule did not. Three
   explanations were tested and rejected (dangling `queueId`, upstream omission at this
   tag, an aborted seeding loop). The cause is still unexplained, which is precisely why
   it is declared: whatever removed it once can remove it again, and now re-applying is a
   one-liner. Symptom was `WARN Strategy not found ... id = "report"` on every DMARC/TLS
   report send, with delivery silently falling back to a hardcoded default.
2. Its values differ from upstream's. Upstream uses custom retry `30m, 1h, 2h` and expiry
   `8 attempts`; this uses the default retry ladder and a 3-day TTL, chosen 2026-08-29.

The `report` **virtual queue** is stock and would otherwise be omitted. It is here solely
as the target of the `#vq-report` reference — `apply` resolves `#` references only against
objects declared in the same plan. Upserting it is a no-op.

## Archive-everything: what it does and how it is kept in place

Goal: every delivered message also lands in the account's archive mailbox, so deleting from
the Inbox — or iOS emptying Trash after its default seven days — does not destroy it. That
is not belt-and-braces: **iOS does not expose _Advanced_ at all for accounts installed from
a configuration profile**, so `Remove → Never` cannot be set by the people this server is
set up for. The server-side copy is the entire mechanism.

It costs no storage. `ingest.rs` takes a `Vec` of mailbox ids on a _single_ document, so
this is one message in two mailboxes, verified live as `mailboxId = [5, 0]`. Deleting from
the Inbox only untags one — `expunge.rs` destroys a message solely when
`mailboxes.len() == 1`.

**Declared here:** `Email.defaultFolders` (archive named `Archive`) and the `archive-all`
`SieveUserScript`.

**Applied per account by `stalwart-sieve-reconcile`**, a daily CronJob, because per-account
Sieve is the one thing the management API cannot reach — `Account` has no script field. It
impersonates over ManageSieve as `<target>%<impersonator>`.

The script targets the archive by **special-use role**, not by name:

```sieve
fileinto :copy :specialuse "\\Archive" :create "Archive";
```

Name-matching would silently create a _second_ mailbox for anyone who renamed theirs, and
start filing into that instead — a failure that looks like nothing at all.

The spam branch is load-bearing, not cosmetic. Stalwart files spam to Junk at
`ingest.rs:357` behind `mailbox_ids == [INBOX_ID]`, an **exact vector equality**, so any
`fileinto` breaks it and spam would land in the Inbox. The script therefore makes the Junk
decision itself, reproducing Stalwart's threshold exactly: `is_spam()` is
`spam_percentage >= 50`, and `spam_status()` maps Ham→1, MaybeSpam(pct)→`((pct*10) as
i64).clamp(2,9)`, Spam→10, Unknown→0 — so `spamtest >= 5` matches at every boundary. Spam
is deliberately _not_ archived, so emptying Junk actually frees it.

**Apple Mail displays it as "Archive" regardless of the server-side name**, because clients
show special-use mailboxes under their own standard names. Marking it `\All` would let it
show as "All Mail" the way Gmail does, but Stalwart's `SpecialUse` enum has no `All` variant.

**Sent is deliberately not covered.** `APPEND` has no Sieve path, so mail you compose lives in
its Sent mailbox only. That is a non-goal rather than a gap: the point of archive-everything is
that *delivered* mail survives a client deleting it, and nothing deletes Sent behind your back.

## Sieve scripts are validated on create

Stalwart compiles a script when the object is **created**, not when configuration is built
at startup. A broken script fails the `apply` loudly:

```
✗ upsert SieveUserScript: error: invalidProperties |
  Failed to compile user Sieve script: Undeclared capability 'relational' at line 10, column 13
```

That is exactly how the missing `relational` require was caught — `:value "ge"` is RFC 5231.
It also means the plan **cannot publish an uncompilable script**, which removes the failure
mode this work was most exposed to: a script that breaks delivery for whoever activates it.

## Adding to the plan

Derive the JSON, never hand-write it. The encodings are not guessable — `expiry` and
`retry` are `@type`-tagged unions, durations are milliseconds, and `intervals` is a **map
keyed by stringified index**, not an array:

```json
"retry":{"@type":"Custom","intervals":{"0":{"duration":900000},"1":{"duration":1800000}}}
```

So: change it in the admin UI, snapshot it, diff against the default, and keep only what
differs.

```bash
./scripts/stalwart-apply snapshot MtaVirtualQueue MtaDeliverySchedule
```

`snapshot` emits exactly what `apply` consumes, with `#` references already wired, and
refuses to emit a dangling reference — it will tell you which type to add to the selection.

## Two exceptions to delta-only, both deliberate

- **`Email.defaultFolders` declares all six folders**, not just the archive rename. A
  JSON-pointer patch merges into an existing map but _creates_ one when nothing is stored —
  and a fresh server stores nothing, since the folders come from code defaults. The pointer
  patch therefore produced a map containing `archive` alone, which would have given every
  future account no Inbox, Sent, Drafts, Trash or Junk. Silently: the apply succeeded and
  the UI looked right.
- **Both tracers are declared.** A fresh server has only the stock `Log` tracer writing to a
  file, so nothing reaches stdout, nothing reaches Loki, and every log-derived alert is dead
  while the server looks healthy and quiet. The stdout tracer is added and the file one
  disabled — it cannot write anyway, because `/var/log/stalwart` does not exist in the image.

Both were found by rebuilding, not by reading. Neither was visible in a diff of the running
server against the plan, because the running server already had them.

## `requireClientRegistration` covers Stalwart's own UI too

`OidcProvider.requireClientRegistration` is `true`, so **every** OAuth client must be declared
here — including `stalwart-webui`, the client Stalwart's own admin and account UI uses against
its own OIDC provider. It is not exempt for being built in.

Setting that flag in Phase 8 without registering `stalwart-webui` broke admin login, and the
symptom pointed away from the cause: the password and TOTP were accepted, then the browser
raised a **native basic-auth dialog**. The log says exactly what happened, on adjacent lines:

```
INFO  Authentication successful (auth.success) ... accountName = "scott@willeke.com", accountId = 3
ERROR Authentication error   (auth.error)   ... details = "Invalid client registration."
```

Authentication succeeds; the *authorization* step then rejects the unregistered client, and the
SPA falls back to basic auth, which the browser renders as a credential prompt. Anyone reading
that dialog will debug the password, TOTP, or the ingress — none of which is involved.

It stayed hidden because Phase 8's verification exercised webmail login, where the client
(`bulwark-webmail`) *was* registered. **Turning on a registration requirement is not testable
against one client.** After changing anything on `OidcProvider`, log in through every UI that
speaks OIDC to this server, not just the one the change was for.

## Split-delivery relay for willeke.com family addresses

`willeke.com` is a shared family domain: `scott@willeke.com` is the only real mailbox on
this server, but Scott routinely sends to other `@willeke.com` addresses (his dad,
stepmom, wife, Micah's mailing list) that only exist on Google Workspace, the domain's
actual MX. Discovered 2026-08-31: Mail.app bounced a send to `micah@willeke.com` with
`Mailbox does not exist`, straight from Stalwart, before the message ever reached Google.

**Root cause.** `Domain.allowRelaying` (default `false`) governs what happens when a RCPT
address is in a domain Stalwart hosts (`willeke.com`) but doesn't resolve to a local
account. `false` means "reject outright" — correct for a domain Stalwart fully owns, wrong
here, because Stalwart deliberately owns only one mailbox on a domain Google is
authoritative for. The `google-willeke-com-relay` `MtaRoute` + `MtaOutboundStrategy
route/else` above already exist to handle exactly this kind of address, via
`smtp-relay.gmail.com` — but `route/else` only fires for domains Stalwart does *not*
consider local, so willeke.com siblings never reached it. `allowRelaying: true` is what
routes them there instead of rejecting.

**Why `allowRelaying: true` alone would be unsafe.** It has no authentication condition —
unlike the *other* `allowRelaying` field (`MtaStageRcpt.allowRelaying`, for domains
Stalwart doesn't host at all), which defaults to `!is_empty(authenticated_as)`. Port 25 is
internet-reachable with no SMTP-level IP restriction (it has to be — that's how Google's
dual-delivery copy of Scott's own mail arrives). Flipping the domain flag alone would let
any anonymous sender on the internet `RCPT TO` a made-up `@willeke.com` address and have
Stalwart relay it out through `smtp-relay.gmail.com` using Scott's own smart-host
credentials — an open relay scoped to this domain, risking Google flagging/suspending that
relay account and delivering spam to real family mailboxes. DMARC/SPF/DKIM verification
does not cover this: those validate whether a *sender's claimed domain* is authorized to
send as itself, not who's allowed to relay through Stalwart or who the recipient is. A
spammer using their own legitimately-authenticated domain sails through all three while
abusing the relay.

**The fix: gate the relay on authentication, not on a family-address allowlist.** The
`relay-guard` `SieveSystemScript`, wired via `MtaStageRcpt.script`, rejects any RCPT for
`willeke.com` where the address is not one of this server's own real mailboxes **and** the
session is unauthenticated:

```sieve
if envelope :domain :is "to" "willeke.com" {
    if eval "!key_exists('willeke-local-mailboxes', to_lowercase(envelope.to)) && is_empty(env.authenticated_as)" {
        reject "550 5.7.1 Relaying denied";
    }
}
```

(`eval` runs in the Sieve `env.*`/`envelope.*` namespace, not the bare `rcpt`/`authenticated_as`
names used by `MtaStageRcpt`'s own JSON `Expression` fields — different context, same server. Two
failed `apply`s to learn this the hard way: `Invalid variable or function name "rcpt_domain"`,
then `"is_local_address"`. The latter is real, but only in the *other* expression engine —
`stalw.art/docs/sieve/reference` lists Sieve's own function set, which has `is_local_domain` but
no address-level equivalent. `key_exists` against a `MemoryLookupKey` list is the Sieve-native way
to do a membership check that isn't baked into the script text.)

**`willeke-local-mailboxes`** is a `MemoryLookupKey` list — "small, slow-changing set, consulted
from Sieve filters," per Stalwart's own description of the feature. Today it holds one record,
`scott@willeke.com`. **Provisioning a second real mailbox on this domain means adding a matching
`MemoryLookupKey` record in the same namespace — the Sieve script itself never needs to change
again.** Forgetting that step doesn't silently misbehave either: the new mailbox would just keep
getting `550 Relaying denied` from anonymous senders (including Google's dual-delivery, if ever
extended to it) until the record is added, which is a loud, obvious failure rather than a subtle
one.

This works because Stalwart's own default `MtaStageAuth` policy already splits the two paths
that matter here: SASL AUTH is **disabled on port 25** (`require` defaults to `local_port !=
25`), so `authenticated_as` is always empty there — covering both Google's dual-delivery copy
(unauthenticated by nature, but addressed to `scott@willeke.com`, which is in the list, so it's
unaffected) and anonymous internet senders (rejected, since they're neither local nor
authenticated). Scott's own clients authenticate on the submission port (465, the app-password
prompt in the mobile config profile), so `authenticated_as` is always non-empty there, the rule
never fires, and the RCPT is *accepted* — with no per-*family*-recipient allowlist to maintain
as those addresses come and go.

**Acceptance is not delivery — a second, separate bug.** `allowRelaying` and `relay-guard` only
govern whether Stalwart accepts a `@willeke.com` RCPT; they say nothing about where the message
goes afterward. That's `MtaOutboundStrategy.route` (see the main `README.md`'s "Sending"
section), and its condition was still the stock `is_local_domain(rcpt_domain)` — true for the
whole domain, mailbox or not. First deploy of `allowRelaying: true` fixed the client-side
`Mailbox does not exist` rejection, then immediately produced a *different* failure: the message
was accepted, queued, and then Stalwart's own `local` delivery queue bounced it right back with
a DSN, because `micah@willeke.com` genuinely isn't a local mailbox. Confirmed in the queue log —
`queueName = "local"` for `micah@willeke.com` while the other three recipients went out
`queueName = "remote"` via `smtp-relay.gmail.com` in the same delivery attempt. The route
condition now also checks `willeke-local-mailboxes` — the same list `relay-guard` uses — so
`'local'` only fires for addresses that are real mailboxes here; the two mechanisms guard the
same set for two different reasons (RCPT-time relay-abuse vs. outbound routing) but share one
source of truth instead of drifting.

## Rules

- **`upsert` only.** Never `reconcile` (destroys every object of a type the plan does not
  declare) and never `destroy`. With a delta-only plan, `reconcile` would delete every
  stock object on the server.
- Applying does **not** restart Stalwart, and Stalwart builds its configuration at startup.
  Restart after applying anything that must take effect:
  `kubectl --context nas -n email-stalwart rollout restart statefulset stalwart`

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

## Rules

- **`upsert` only.** Never `reconcile` (destroys every object of a type the plan does not
  declare) and never `destroy`. With a delta-only plan, `reconcile` would delete every
  stock object on the server.
- Applying does **not** restart Stalwart, and Stalwart builds its configuration at startup.
  Restart after applying anything that must take effect:
  `kubectl --context nas -n email-stalwart rollout restart statefulset stalwart`

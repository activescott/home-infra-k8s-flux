# Stalwart configuration as code

Move Stalwart's datastore-resident configuration into git as declarative,
re-runnable `stalwart-cli apply` plans, executed in-cluster as a Kubernetes Job.

## Problem

Every Stalwart decision made during Phase 7 lives **only in the server's datastore**.
None of it is in git, none of it is re-appliable, and none of it is visible to Flux:

| Setting                                             | Where it came from            |
| --------------------------------------------------- | ----------------------------- |
| The `report` delivery schedule                      | admin UI, 2026-08-29, by hand |
| Prometheus exporter + `authSecret`                  | admin UI                      |
| Outbound strategy (the Google smarthost route)      | admin UI                      |
| _Obtain remote IP from Forwarded header_ + pod CIDR | admin UI                      |
| Default folder set for new accounts                 | admin UI                      |
| Per-account app passwords, TOTP, Archive folder     | admin UI                      |

Three consequences, all of which have already cost time:

1. **Saving a setting does not apply it.** Stalwart builds configuration at startup,
   so every change needs a pod restart. This has been hit four times — the outbound
   strategy, a stale `BlockedIp`, the metrics `authSecret`, and the `report` schedule.
2. **There is no record of intent.** The mailbox PV is snapshotted and backed up, but a
   restore returns whatever the database held, not a reviewable statement of what we
   meant. A rebuilt server would be reconstructed from memory and README prose.
3. **It is invisible to review.** A configuration change that alters mail handling
   leaves no diff, no commit, no PR.

Scott's framing, and the reason this is worth doing now rather than later:
**"scripts are better than readmes."**

## What exists (verified, not assumed)

- **`stalwart-cli` is a separate repository**, `stalwartlabs/cli`, on its own versioning —
  latest **v1.0.12** (2026-07-28). It is **not** in the server image, which carries only
  `/usr/local/bin/stalwart`.
- It drives the **same JMAP management API as the WebUI**.
- **`apply` consumes NDJSON** — one JSON object per line, no enclosing array — with five
  operations:

  | Op          | Behaviour                                                           |
  | ----------- | ------------------------------------------------------------------- |
  | `upsert`    | match by natural key, update in place or create. **Never deletes.** |
  | `reconcile` | upsert, then **destroy every unmatched object of that type**        |
  | `update`    | JMAP-style patch to an existing object                              |
  | `create`    | one-shot; fails on re-run                                           |
  | `destroy`   | filter-based delete                                                 |

  Plus `matchOn` (natural-key property list), `#<id>` cross-references, `--dry-run`,
  `--continue-on-error`, `--json`, and a three-pass destroy → apply → cleanup order.

- **API keys** authenticate as HTTP bearer tokens, support `inherit` / `disable` /
  `replace` permission modes, and **cannot log in over IMAP, POP3, JMAP-mail, SMTP
  submission, or any CalDAV/CardDAV/WebDAV service.** Management only. The secret is
  displayed **once** at creation.
- **Object and property names are already known.** `crates/registry/src/schema/structs.rs`
  at tag `v0.16.19` carries the serde renames, which _are_ the API property names — e.g.
  `MtaDeliverySchedule{name, description, expiry, notify, queueId, retry}`,
  `SieveUserScript{name, description, isActive, contents}`. Plans can be authored exactly
  rather than guessed, then checked with `--dry-run`.

## Decisions

0. **Only deltas from Stalwart's defaults are declared.** A fresh server seeds its own
   defaults at first boot, so the plan carries only what we deliberately differ on. It
   stays a statement of intent rather than a mirror of the server, and it will not fight
   upstream if their defaults change in a future release. A rebuild is: install, let it
   seed, then apply. Scott's call, 2026-08-29, correcting an earlier draft of this plan
   that declared all four virtual queues — every one of them stock.

   The corollary is that **`reconcile` becomes actively dangerous**: against a delta-only
   plan it would destroy every stock object on the server. Decision 1 already forbids it;
   this makes it non-negotiable.

   The one admitted exception is a reference target. `apply` resolves `#` references only
   against objects declared in the same plan, so the stock `report` virtual queue is
   upserted purely so `#vq-report` resolves. Upserting it is a no-op, and it is annotated
   as such in `stalwart-config/README.md`.

1. **`upsert` only.** No `reconcile` and no `destroy` in any committed plan. `reconcile`
   deletes every object of a type the plan does not declare; on a mail server that is a
   footgun with no upside. Approved by Scott 2026-08-29.
2. **Runs in-cluster as a Kubernetes `Job`** in `email-stalwart`, reaching Stalwart over
   its in-cluster Service rather than the public admin host.
3. **A dedicated API key, not `STALWART_RECOVERY_ADMIN`.** Least privilege, and an API key
   structurally cannot touch mail. Scott mints it; it is SOPS-encrypted without being read,
   matching how every other credential in this project was handled.
4. **The CLI image is pinned by digest in git**, not by a moving tag.
5. **Plans are NDJSON files in git**, mounted into the Job from a ConfigMap.

## Getting the CLI into the cluster

**There is an official published image**, so nothing needs building or downloading:

```
docker.io/stalwartlabs/cli:1.0.12@sha256:fe199affac1d120a8c200ef39ae629765a2976270e0453575c1caf906ee15b52
```

Also mirrored at `ghcr.io/stalwartlabs/cli`. Multi-arch (`amd64` + `arm64`, node is
`amd64`), ~4 MB, published 2026-07-28 alongside the v1.0.12 release. **Pin by digest**,
not by tag — `1.0` and `latest` both move.

This was nearly missed. An initial check for org container packages returned nothing and
looked authoritative; it had actually failed on shell glob expansion of the `?` in the
query string. _Re-run a negative result before designing around it._ The rejected
alternatives — downloading the release tarball at Job start with a pinned
sha256 (`76fcd725…acce` for `stalwart-cli-x86_64-unknown-linux-musl.tar.xz`), or building
and publishing our own image to the local zot registry — are both strictly worse now:
one adds a GitHub dependency at apply time, the other a build pipeline for a tool we run
occasionally.

## CLI interface

Documented in the CLI repo's README. Configuration is entirely by environment variable,
which suits a Kubernetes Job with a `secretKeyRef`:

| Variable                              | Purpose                   |
| ------------------------------------- | ------------------------- |
| `STALWART_URL`                        | server endpoint           |
| `STALWART_TOKEN`                      | API key (bearer)          |
| `STALWART_USER` / `STALWART_PASSWORD` | alternative to token auth |

```sh
stalwart-cli apply --file plan.json
stalwart-cli query Account --fields id,name
```

The image runs as `nonroot` and caches under `/home/nonroot/.cache`, so the Job needs a
writable volume there (an `emptyDir` is enough).

## API key permissions — least privilege, enforced structurally

Use `replace` mode with an explicit list rather than `inherit`. The exact permission names
come from `crates/registry/src/schema/enums_impl.rs`:

```
sysMtaVirtualQueueGet       sysMtaVirtualQueueQuery       sysMtaVirtualQueueCreate       sysMtaVirtualQueueUpdate
sysMtaDeliveryScheduleGet   sysMtaDeliveryScheduleQuery   sysMtaDeliveryScheduleCreate   sysMtaDeliveryScheduleUpdate
sysSieveUserScriptGet       sysSieveUserScriptQuery       sysSieveUserScriptCreate       sysSieveUserScriptUpdate
```

**Grant no `*Destroy` permission.** Every object type exposes a discrete `Destroy`
permission, and since the plans are `upsert`-only they never need one. Omitting them means
the key **cannot delete a queue, schedule or script even if a plan is wrong or the key
leaks** — the upsert-only decision stops being a convention and becomes something the
server enforces. Add permissions later, one at a time, as the plans grow.

## Work items

1. **Scott mints the API key** in the admin UI, `replace` mode with exactly the
   permissions listed above and no `Destroy`, then pastes it into
   `apps/production/email-stalwart/.env.secret.stalwart-cli` as `STALWART_TOKEN`.
   The secret is shown **once** — capture it to 1Password at the same time.
2. SOPS-encrypt it via `./scripts/encrypt-env-files.sh apps/production/email-stalwart`,
   without reading the plaintext.
3. `stalwart-apply-job.yaml` + kustomization wiring, with the plans as a ConfigMap.
4. The plans themselves, smallest and least risky first:
   - `00-queues.ndjson` — `MtaVirtualQueue` + `MtaDeliverySchedule`. **Codifies the
     `report` schedule created by hand on 2026-08-29**, which is the natural first test:
     an `upsert` against an object that already exists must be a no-op.
   - `10-defaults.ndjson` — default folder set for new accounts, adding `All Mail`.
   - `20-sieve.ndjson` — the global `SieveUserScript` holding the archive-all logic.
   - `30-accounts.ndjson` — per-account active script and Archive role.
   - Later: telemetry/metrics, outbound strategy, allowed IPs.
5. `scripts/stalwart-apply` wrapper — dry-run, show the diff, then apply.
6. Update `apps/production/email-stalwart/README.md` to point at the plans as the source
   of truth, and record which settings are still click-ops.

## Verification

- **`--dry-run` before every apply.** Never apply an unreviewed plan.
- **Apply twice.** The second run must report zero creations. That is the idempotency
  proof, and it is the whole reason for choosing `upsert`.
- **Start with an object that already exists** (the `report` schedule) so the first real
  apply is provably a no-op.
- **Restart the pod afterwards** and confirm the setting took — the startup-only config
  build has not gone away. Determine whether `apply` triggers a reload on its own.
- **GTUBE** for the Sieve work: confirm a guaranteed-spam message still files to `Junk`
  with `$Junk` set and no `All Mail` copy, before enabling it on a real account.

## Durability

Per `AGENTS.md` tenet #1 and the mail-durability rules in the email-infrastructure spec.

- **Does it write, move or delete user data?** No. Plans are configuration only, and
  `upsert` cannot delete. No plan may contain `reconcile` or `destroy`.
- **Worst realistic loss?** A bad Sieve script breaking delivery for accounts that
  activate it. Mitigated by staging on a throwaway account and by the fact that Sieve
  activation is per-account, so blast radius is one mailbox until deliberately widened.
- **The credential cannot destroy mail.** An API key is refused by IMAP, POP3, JMAP-mail,
  SMTP submission and every DAV service, so even a leaked key cannot read or delete a
  message.
- **Backups unchanged.** Nothing here touches the PV, the snapshots, or the B2 job.
- **This improves recoverability**: after a datastore loss, configuration becomes
  `apply`-able rather than reconstructed from memory.

## `snapshot` — derive plans, never hand-write them

Settled 2026-08-29, and it removes the largest authoring risk. `stalwart-cli snapshot
<Object>...` reads live objects and emits **exactly the NDJSON `apply` consumes**, with `#`
references already wired. It also refuses to emit a dangling reference, naming the type to
add to the selection.

This matters because the encodings are not guessable. `expiry` and `retry` are
`@type`-tagged unions, durations are milliseconds, and **`intervals` is a map keyed by
stringified index, not an array**:

```json
"retry":{"@type":"Custom","intervals":{"0":{"duration":900000},"1":{"duration":1800000}}}
"expiry":{"@type":"Ttl","expire":259200000}
"expiry":{"@type":"Attempts","maxAttempts":10}
```

Workflow for anything new: change it in the admin UI, `./scripts/stalwart-apply snapshot
<Object>`, diff against the stock default, and keep only what differs.

**The CLI is CRUD only** — `get`, `query`, `create`, `update`, `delete`, `describe`,
`apply`, `snapshot`. There is no action or invoke verb, so server actions such as
`ReloadTlsCertificates` are not reachable through it; see the comment in
`stalwart-tls-reload.yaml`.

## Open questions

- Minimum API-key permission set for the objects we manage. Currently `inherit` on the
  admin account, which is over-privileged; narrowing is a create-new-key-and-swap.
- Whether a message in two mailboxes counts once or twice against quota.
- Whether `include :global` is worth using at all, now that per-account activation is a
  manual import either way.

Resolved 2026-08-29:

- **`ActiveScriptId` is not settable through a plan.** `Account` has no script field, and
  per-account Sieve scripts live in the account's JMAP data rather than the config
  registry. Publishing a `SieveUserScript` and importing it per account is the supported
  path — upstream describes it as "available for user imports".
- **A system Sieve script cannot file into a mailbox.** No `Event::FileInto` in
  `crates/smtp/src/scripts/event_loop.rs`; unhandled events return `NotSupported`.
- **Nested map fields patch by JSON pointer and merge.**
  `{"defaultFolders/archive/name": "All Mail"}` renamed one entry and left the other five
  untouched — verified by snapshotting before and after. A restore plan was prepared first
  in case it replaced the map instead; it was not needed, but preparing it was the right
  call for a first use of an unfamiliar patch semantic.
- **Sieve scripts are validated on create, not at startup.** A bad script fails the apply
  rather than degrading delivery later. This caught a missing `relational` capability.
- **`apply` does not restart Stalwart or reload configuration.** A restart is still needed
  for anything that must take effect.
- **The CLI is CRUD-only** — `get`, `query`, `create`, `update`, `delete`, `describe`,
  `apply`, `snapshot`. No action verb, so `ReloadTlsCertificates` stays unreachable.

Resolved: `apply` does **not** restart Stalwart or trigger a config reload, and Stalwart
builds configuration at startup — so a restart is still required after applying anything
that must take effect.

## Related

- Task #46. The Sieve archive-all design and its spam-equivalence proof are in
  `home-infra-private/docs/specs/email-infrastructure/summary.md`.
- Task #44 (the `report` schedule) is the first thing this codifies.

# Declarative Stalwart configuration

`plan.ndjson` is applied by `stalwart-cli` from a Job in this namespace. Design and
rationale: [`docs/specs/stalwart-config-as-code/plan.md`](../../../../docs/specs/stalwart-config-as-code/plan.md).

```bash
./scripts/stalwart-apply plan                      # dry run, sends nothing
./scripts/stalwart-apply apply
./scripts/stalwart-apply snapshot <Object> [...]   # derive plan JSON from live state
./scripts/stalwart-apply query <Object> --fields name,...
```

`plan` and `apply` run whatever plan is **deployed**, not what is in your working tree.
Commit and let Flux reconcile first.

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

## Rules

- **`upsert` only.** Never `reconcile` (destroys every object of a type the plan does not
  declare) and never `destroy`. With a delta-only plan, `reconcile` would delete every
  stock object on the server.
- Applying does **not** restart Stalwart, and Stalwart builds its configuration at startup.
  Restart after applying anything that must take effect:
  `kubectl --context nas -n email-stalwart rollout restart statefulset stalwart`

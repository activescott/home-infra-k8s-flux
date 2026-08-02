# gpupoet `app` — rollout availability hardening

## Summary

On 2026-08-02 a routine gpupoet deploy caused ~5 minutes of **intermittent**
user-facing errors (~229× HTTP 503 + ~5–7× HTTP 502 served to real clients)
while the single `app` replica **crash-looped after** an otherwise-successful
rollout. This spec documents the incident, corrects a common misconception
about what would have prevented it, and defines the remediation implemented in
this PR plus recommended follow-ups.

## Incident timeline (UTC, 2026-08-02)

| Time | Event |
|------|-------|
| 17:32:29 | PR #53 merged to `activescott/gpu-agent` `main`; CI `build.yaml` starts |
| ~17:39 | Image `v202608021735` published; Flux `policy-gpupoet-app` resolves it (`v202608020723 → v202608021735`) and patches the `app` deployment |
| 17:40:25 | New pod `app-7b84ff78cb-hv8lw` created |
| ~17:41 | Image pulled (1m9s) |
| ~17:43 | New pod passes readiness → `1/1`; rollout reports **successfully rolled out** |
| 17:44:07 | Old ReplicaSet `app-7f6d4df67d` scaled `1→0`, old pod deleted (normal rollout completion) |
| 17:44:55 | New pod **liveness probe fails → SIGKILL (exit 137)**, restart #1 |
| 17:44–17:48 | **Crashloop** (4 restarts). Each restart re-runs the Prisma DB seed before `next start` binds `:3000`; liveness hits an unbound port (`connection refused`) and kills the container again |
| 17:44–17:48 | During not-ready windows the `app` Service endpoints list is empty → Traefik returns `503 "no available server"` for `/` |
| 17:48:24 | Final container start; seed + warmup complete; pod stabilizes `1/1` and holds |

## Customer impact (measured)

Source: Traefik `traefik_entrypoint_requests_total` / `traefik_service_requests_total`
(datasource `Prometheus`), `websecure` entrypoint, ~16–17 min window ending 17:52.
The **prior 17-minute window baseline was all-zero for 5xx**, so every error below
is attributable to this incident and to gpupoet (the only unhealthy service).

| Result | Count (approx) |
|--------|----------------|
| `200` (served normally between blips) | ~604 |
| `308` redirects | ~53 |
| **`503` "no available server"** (entrypoint) | **~229** |
| **`502` Bad Gateway** | **~5–7** |
| `499` client-cancelled | ~4 |

**Verdict:** a ~5-minute **intermittent partial outage** — a few hundred external
requests received 5xx — **not** a full blackout. The pod served 200s normally
between the not-ready blips. (Note: `traefik_service_requests_total` for the app
service shows `503 = 0` because empty-endpoints 503s are attributed at the
entrypoint/router level, not the service; the ~229 appears on the entrypoint
metric.)

## Root cause

Three compounding factors, none of which is the rollout strategy:

1. **Trigger — over-aggressive liveness probe.** `livenessProbe` used the default
   `timeoutSeconds: 1`. Right after the pod became Ready, cold-start cache
   warming / ISR briefly pushed a health check over 1s → 3 consecutive failures
   → kubelet SIGKILL. `exit 137` with `reason: Error` is this liveness kill, not
   an application crash — the app logged a clean `✓ Ready` and was serving.
2. **Amplifier — DB seed on every boot, no `startupProbe`.** The container runs a
   Prisma seed before `next start` binds `:3000`. On each restart the seed window
   can exceed the liveness `initialDelaySeconds: 40`, so liveness probes hit an
   unbound port (`connection refused`) and kill the container again →
   self-perpetuating crashloop.
3. **No fallback — `replicas: 1`.** Once the old pod was removed at the end of the
   (successful) rollout, the single unhealthy replica meant **zero backends**
   during each not-ready blip → Traefik `503`.

## Why "surge a 2nd pod + `maxUnavailable=0`" alone would NOT have prevented it

The initial hypothesis was that keeping the old pod up until the new one is
stably up would have avoided impact. Important correction:

- The base Deployment has **no explicit `strategy`**, so Kubernetes applies the
  default `RollingUpdate 25%/25%`. For a **1-replica** deployment that rounds to
  **`maxSurge=1`, `maxUnavailable=0`** already.
- So the rollout was *already* safe: it surged a 2nd pod, waited for readiness,
  and only then removed the old pod. The old pod was correctly retained until the
  new pod was Ready.
- **The incident happened AFTER the rollout completed.** Rollout-strategy tuning
  governs the rollout window only; it cannot protect a running single replica
  that later crash-loops.

What actually breaks the failure mode is (a) a **`startupProbe`** so the slow
seed + warmup finishes before liveness/readiness engage (making "stably up" real
and breaking the crashloop), (b) a **tolerant liveness probe** so an
already-serving pod is not killed for a transient pause, and (c) for full
availability, **a second replica**.

## Remediation (this PR)

Edits to `apps/base/gpupoet/app-deployment.yaml`:

1. **Explicit rollout strategy** — codify `maxUnavailable: 0`, `maxSurge: 1`
   (documents intent; matches the current effective default, no behavior change).
2. **Add `startupProbe`** — `GET /api/health/readiness`, `periodSeconds: 10`,
   `failureThreshold: 30` (≈5 min budget). Liveness/readiness do not run until
   startup succeeds, so the boot seed + Next warmup can never trip a crashloop,
   and future rollouts keep the old pod until the new one is genuinely up.
3. **Harden `livenessProbe`** — `timeoutSeconds: 1 → 5`, `failureThreshold: 3 → 6`;
   drop `initialDelaySeconds` (the startupProbe gates it). An already-serving pod
   now tolerates GC / event-loop pauses instead of being killed.
4. **Harden `readinessProbe`** — `timeoutSeconds → 5`; drop `initialDelaySeconds`.

These changes are low-risk (probe/strategy only) and would have prevented this
incident by stopping the crashloop at its trigger.

## Recommended follow-ups (NOT in this PR — decisions for review)

- **`replicas: 1 → 2` for true HA.** The only change that fully eliminates
  single-replica outage risk: a pod dying never drops all backends. Cost: ~2×
  memory (limit `2Gi` each) and the boot seed runs per-pod — **verify the seed is
  idempotent / concurrency-safe** before enabling. Strongly recommended.
- **Move the DB seed out of the app boot path** (init/migration Job) so app pods
  start fast and don't re-seed on every restart — removes the amplifier entirely.
- **`/ops/*` ingress black-hole noise.** `gpupoet-app-ingress` intentionally
  routes `/ops/revalidate-ebay|revalidate-amazon|cleanup-listings` to
  `nonexistent-service` (deny external access). It's by design but emits constant
  Traefik `"Cannot create service"` reconcile errors (~12–51 / 10 min). Optionally
  replace with a proper deny/`404` middleware to quiet the logs.

## Validation & rollback

- `kubectl kustomize apps/production/gpupoet` renders cleanly.
- After merge, Flux reconciles via GitHub webhook (do not `flux reconcile`
  manually). Watch the rollout: confirm the new pod passes `startupProbe` then
  serves, and confirm no 5xx spike in `traefik_entrypoint_requests_total`.
- **Rollback:** revert the commit; Flux reconciles back to the prior manifest.

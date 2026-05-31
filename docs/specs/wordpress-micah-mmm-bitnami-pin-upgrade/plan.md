# wordpress-micah-mmm: Bitnami image pin + upgrade

## Background

The `wordpress-micah-mmm` namespace runs Micah's small-business mowing
website (mmm.willeke.com) via the `bitnami/wordpress` Helm chart
(v29.1.1). Both the wordpress container and the chart's bundled
mariadb container were tagged `:latest` in the cluster — i.e. the
deployed bytes depended on whatever Bitnami chose to point `:latest`
at when the pods were last scheduled. Pods were 95 days old at the
start of this work, so they were running on whatever was current
~2026-02-24.

Bitnami changed their public OCI image distribution in Aug 2025
(most non-`:latest` tags moved to their paid product). That makes a
`:latest`-only pin a real supply-chain risk: the next reschedule
could swap in a different image without any GitOps diff.

## Goal

Move from `:latest` to a digest-pinned reference in two reversible
steps so that anything going wrong can be diffed and rolled back.

## Plan

### Step 1 — Pin to current (zero-behavior-change)

Add `image.digest` and `mariadb.image.digest` to the micah overlay's
HelmRelease values, set to the digests **already running** in the
cluster as of 2026-05-30:

| Component | Resolved version | Digest |
|---|---|---|
| wordpress | WordPress 6.9.1 / Photon OS 5 | `sha256:a767c9fcab3eb2c140c791fb0095b575cb9696ea1732972bc8e0b522194f68a1` |
| mariadb | MariaDB 12.2.2 | `sha256:3092b0b72758aedadea2f16ad352388f0067ec68a6a58672a6a7ae61d4278e81` |

This step is *not* a no-op for the rollout — the rendered pod-spec
image reference changes from `bitnami/wordpress:latest` to
`bitnami/wordpress@sha256:...`, so Helm computes a new template
hash and both pods roll. The pulled bytes are identical (digest
already on node), so the new pods come up fast.

Downtime expected:
- wordpress Deployment: ~30-60s (1 replica, RWO PVC handoff).
- mariadb StatefulSet: ~30-60s (1 replica, RWO PVC handoff).

Total: under 2 min, and roughly midnight PDT.

Success criteria:
- HelmRelease reconciles successfully.
- Both new pods reach Ready, 0 restarts, image digest matches the pin.
- `https://mmm.willeke.com` returns 200.

### Step 2 — Upgrade image digests to current Bitnami `:latest`

Probe current `:latest` digests via the docker registry HTTP API
(no docker daemon required), update the same two `image.digest`
fields. Chart version stays at 29.1.1 (smallest possible change
vector — image-only upgrade).

Same downtime profile (1-replica RWO).

Success criteria:
- HelmRelease reconciles.
- Both new pods reach Ready, 0 restarts.
- wp-admin loads and WP DB schema upgrades succeed (post-upgrade
  notice in `/wp-admin/upgrade.php` if needed).
- MariaDB pod logs show clean start, no auto-upgrade complaints.
- `https://mmm.willeke.com` returns 200.

### Failure handling

The site is the user's son's business; the user is asleep. If any
step fails:
1. Revert the offending commit immediately on `main` (separate
   commit, not `git revert --no-commit` chains).
2. Push.
3. Wait for Flux to reconcile the revert and verify pods recover.
4. Write `summary.md` documenting what failed.

Memory `feedback-no-auto-revert-discuss-first.md` says don't
auto-revert on failure. That memory is overridden for this session
by the user's explicit "I'm going to bed. Commit and push as
needed" + "Just make sure we don't screw it up" instruction.
Auto-revert is the right move because hours of overnight
brokenness on his son's site is worse than reverting silently.

## Out of scope (deferred)

- Bumping the chart version (29.1.1 → current). Larger change
  vector; do as a separate step after this.
- Pinning by digest for the chart artifact itself (HelmRepository
  is OCI; chart version `29.1.1` is already exact).
- Repo-wide standardization of `:latest`-tag pinning across other
  workloads (separate task).

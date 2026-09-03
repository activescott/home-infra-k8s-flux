# Renovate setup — summary

## What was done (2026-09-03)

- `renovate.json5` added at repo root; Mend hosted app installed (this repo only).
  Guardrails: `minimumReleaseAge: "7 days"`; digest pinning scoped to
  `matchDatasources: ["docker"]` (global `pinDigests` broke on the cvat
  GitRepository git tag — Mend job be5c8c82); pin updates ungrouped (one PR per
  pin) so a single bad dep can't block the rest.
- Docker Hub auth: `hostRules` references the `DOCKER_HUB_TOKEN` secret stored
  in the Mend portal (repo Settings > Credentials); username `activescott`.
  Anonymous digest lookups were rate-limited before this.
- Flux-owned images excluded via `enabled: false` packageRule (14 images);
  AGENTS.md "Renovate vs Flux image automation" documents keeping it in sync.
- indexnow-notifier got its own Flux image automation
  (`apps/production/gpupoet/image-scanning-indexnow/`, commit `ef6b7ab`) —
  it had floated on `:latest` with no owner. Pinned to `v202601041830`
  (same digest as latest at the time). ImageRepository registered in the
  webhook receiver.
- Placeholder image names (`/placeholder/`, `/-image(-|$)/`) excluded from
  lookups — they caused "No docker auth found" warnings.

## Merged and verified healthy

- All 15 digest-pin PRs (#23–#37) — same-tag `tag@sha256` pins across
  ~25 workloads; every affected pod rolled clean, zero unhealthy pods.
- Version updates: wordpress 6.9.4 (mmm.willeke.com verified 200 + title),
  alpine 3.24, busybox 1.38, kvrocks 2.16, redis 7.4.11, zwave-js-ui 11.22.3,
  nginx-unprivileged 1.29, alloy chart 1.12.1, grafana chart 11.6.1,
  loki chart 9.5.13, @types/node, tsx. Helm upgrades all succeeded; Loki
  ingestion verified flowing post-upgrade (260 entries/4 min); grafana
  /api/health 200.

## Held for Scott (open PRs, decisions pending)

- #57 postgres 18 major — in-place major = crashloop; recommend close +
  packageRule disabling postgres majors.
- #54 mariadb major (photoprism 10.11→12.3) — needs MARIADB_AUTO_UPGRADE plan.
- #47/#60 Bitnami wordpress chart bumps — repo bans Bitnami; recommend close +
  disable rule. #59 wordpress docker v7 = real WP major, user call.
- #51 grafana 13 / #52 loki 18 / #53 blackbox 11 — chart majors, values
  migrations; do individually as planned upgrades.
- #44 home-assistant 2026.8.3, #56 photoprism 260728, #38 cvat 2.74,
  #58 redis 8 — app upgrades with forward-only migrations.
- #20 alpine/kubectl 1.36 — cluster is v1.33.5+k3s1, skew +3; recommend
  close + `allowedVersions`.
- #39 flux2 v2.9.4 (gotk-components), #49 octokit 22, #50 typescript 7,
  #55 node 24 — system/toolchain, pending user call.

## Gotchas / operational notes

- Renovate dashboard checkboxes: edit issue #18 body, `[ ]`→`[x]` on the
  `<!-- ... -->` markers. Ticks race with running jobs (Renovate rewrites the
  body at run end) — tick right after a run finishes, and combine the action
  checkbox with `<!-- manual job -->` in one edit.
- Mend job logs: developer.mend.io → repo → Recent jobs; JSON lines, `jq`
  friendly. The dashboard "Repository problems" WARNs are aggregates; the log
  names the actual dep/file.
- PR bursts: `config:recommended` = 2 PRs/hour; `<!-- create-all-rate-limited-prs -->`
  releases everything at once (including majors) — used once, wouldn't again.
- Renovate rebases conflicted PRs automatically (tick rebase checkbox or wait
  a run); after pins merged, update PRs became digest→digest diffs.
- gpu-agent CI last pushed a timestamp tag Jan 2026 (`v202601041830`); if CI
  now only tags `latest`, the new indexnow automation will never see an update
  — check gpu-agent's release workflow.

## Quick commands

```sh
# force a Renovate run
gh issue view 18 --json body --jq .body | sed 's|- \[ \] <!-- manual job -->|- [x] <!-- manual job -->|' | gh issue edit 18 --body-file -
# watch reconcile + health
flux --context nas get kustomization apps
kubectl --context nas get pods -A | grep -v "Running\|Completed"
# verify loki ingestion (grafana MCP): query_loki_stats {namespace=~".+"} over last 5m, datasource P8E80F9AEF21F6940
```

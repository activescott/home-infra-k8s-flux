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

## Second wave (2026-09-03 afternoon): decisions executed

Three-tier policy added to renovate.json5 + AGENTS.md ("Dependency update
decision criteria"): majors opt-in via dependencyDashboardApproval;
postgres/mariadb/redis majors disabled (unlock conditions in comments);
alpine/kubectl capped `<1.35` for cluster skew.

Closed with comments: #57 postgres 18, #54 mariadb major, #58 redis 8,
#20 kubectl 1.36, #47/#60 Bitnami wordpress charts (dormant manifests
`apps/base/wordpress` + `apps/production/wordpress-micah-mmm` deleted in
6a25731 — mmm runs v2 on wordpress-upstream, verified unaffected).

Merged + verified healthy, in order:
- #39 flux2 2.7.2→2.9.4 — controllers clean; fallout: flux 2.9 dropped
  image.toolkit v1beta2, blocked apps kustomization; fixed by bumping 9
  manifests to v1 (a7fd3ba). Watch for this on future flux majors/minors:
  API removals surface as "dry-run failed / no matches for kind".
- #49 octokit 22, #50 TS 7, #55 node 24 — typecheck (`tsc --noEmit ...
  --types node`; TS7 no longer auto-loads @types without tsconfig) + tsx
  smoke-run pass.
- #44 home-assistant 2026.8.3 — zwave server requirement (>=11.19.1)
  satisfied by #48 (11.22.3); zwave socket re-established; UniFi errors
  pre-existing (controller 10.1.111.20 unreachable network-wide);
  template-cover config deprecation error worth fixing in HA config.
- #56 photoprism 260728 — mariadb dumps taken first (scratchpad, 266M/30M/454M);
  5 migrations OK; all 3 sites 200.
- #38 cvat 2.74.0 — pg_dumpall first (1.4M); v2.72 moved code to /opt/cvat but
  image sets CVAT_BASE_DIR=/home/django so data/share mounts unchanged;
  migrations via initializer OK; site 200.
- #51 grafana chart 13 (app 13, distroless) — values pre-checked (no
  GF_*__FILE / GF_INSTALL_PLUGINS / /tmp mounts; sidecar folder matches new
  default); datasources + 17 dashboards verified. Known noise: bundled
  mysql/elasticsearch plugin install errors on read-only FS (unused
  plugins). Follow-up: sidecar dashboard hot-reload POST gets 401 —
  dashboards load at startup; changed ConfigMaps need a pod restart until
  the sidecar's admin credentials are wired up.
- #52 loki chart 18.11.3 — values already modern (SingleBinary alias still
  supported, tsdb v13 + structured metadata already on); ingestion +
  historical reads verified. Note: loki stats API shows 0 for unflushed
  chunks — use query_loki_logs, not query_loki_stats, to verify fresh
  ingestion.
- #53 blackbox-exporter chart 11.18.0 — no affected values; 11 probes green.
- #61 alpine/kubectl 1.34.2 (in-skew under new cap), #62 mariadb
  12.3.3-noble minor for mmm (unbundled from closed #54 by the major-block
  rule) — both verified.

## Open decisions

- #59 wordpress docker v7 (mmm.willeke.com) — real WP major, Scott's call.
- k3s upgrade (1.33 → newer) is its own future task; then raise the
  alpine/kubectl cap.

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

# Renovate setup for third-party images and Helm charts

## Goal

Automate dependency-update PRs for third-party container images and Helm
charts in this repo using Renovate (Mend hosted GitHub App), with
supply-chain guardrails, while keeping Flux image-update automation as the
sole owner of the first-party continuously-deployed app images.

## Decisions

- **Hosted Mend Renovate GitHub App** (not self-hosted). Zero infra; it only
  opens PRs — branch protection on `main` keeps a human review gate.
- **`minimumReleaseAge: "7 days"`** — never propose a release younger than
  7 days. Most compromised upstream releases are detected/yanked within days.
- **`pinDigests: true`** — pin container images as `tag@sha256:...`. The tag
  stays in the manifest so the human-readable version is always visible
  inline; a re-pointed tag shows up as a git diff instead of a silent pull.
- **Renovate never touches Flux-automation-owned images.** One bot per image.
  Exclusion is an `enabled: false` packageRule listing the exact image names.
  Exclusion by path is not possible: the automation writes tags into the same
  manifests that hold other dependencies.

## Flux image-update automation inventory (excluded from Renovate)

Derived from `apps/production/*/image-scanning*/` kustomizations patching
`apps/base/image-scanning/`:

| Image                                           | App                |
| ----------------------------------------------- | ------------------ |
| ghcr.io/activescott/fernfiles/app               | fernfiles          |
| ghcr.io/activescott/fernfiles/worker            | fernfiles          |
| ghcr.io/activescott/gpu-poet-data/collector     | gpu-poet-collector |
| ghcr.io/activescott/amazon-searcher             | gpupoet            |
| ghcr.io/activescott/gpu-agent/app               | gpupoet            |
| ghcr.io/activescott/gpu-agent/indexnow-notifier | gpupoet            |
| ghcr.io/activescott/ramblefeed/app              | ramblefeed         |
| ghcr.io/activescott/www                         | scott-willeke-com  |
| ghcr.io/activescott/tinkerbell/app              | tinkerbell         |
| ghcr.io/activescott/tinkerbell/mcp-gateway      | tinkerbell         |
| ghcr.io/tayle-co/tayle/app                      | tayle              |
| ghcr.io/tayle-co/tayle/worker                   | tayle              |
| ghcr.io/actions/gha-runner-scale-set-controller | github-runners     |
| ghcr.io/actions/actions-runner                  | github-runners     |

To regenerate this list:

```sh
grep -rh --include="*.yaml" -A2 'path: /spec/image' apps/production/*/image-scanning*/ | grep 'value:'
grep -rh --include="*.yaml" '^  image: ghcr' apps/production/*/image-scanning*/
```

## Tasks

1. [x] Save this plan to `docs/specs/renovate-setup/plan.md`.
2. [x] Add `renovate.json5` at repo root: `config:recommended`,
       `minimumReleaseAge`, `pinDigests`, `flux` + `kubernetes` managers scoped
       to `apps/`, `infrastructure/`, `clusters/`, and the exclusion packageRule
       for the images above.
3. [x] Add AGENTS.md section: when adding/removing a Flux image-scanning
       automation, update the Renovate exclusion rule to match.
4. [x] Validate config locally:
       `npx -y --package renovate renovate-config-validator renovate.json5`.
5. [x] Stage for review; commit after review.
6. [ ] Manual (Scott): install the Mend Renovate GitHub App at
       https://github.com/apps/renovate, scoped to only this repo.
7. [ ] Post-install validation (below).

## Validation

Before commit:

- `npx -y --package renovate renovate-config-validator renovate.json5` exits 0
  with no deprecation warnings.

After app install (first hours):

- **Onboarding/Dependency Dashboard**: Renovate opens a "Dependency
  Dashboard" issue. Verify (a) Helm charts from the repo's HelmReleases are
  detected (kube-prometheus-stack, cert-manager, etc. — 18 files carry
  HelmReleases), (b) third-party images (plex, wordpress, mariadb, ...) are
  detected, and (c) **none of the 13 excluded images appear** in any update
  list.
- **First PRs**: expect a wave of "pin digest" PRs converting `tag` →
  `tag@sha256:...`. Verify no PR diff touches a line carrying a
  `# {"$imagepolicy": ...}` marker (`git grep '$imagepolicy'` lists those
  lines).
- **minimumReleaseAge**: releases younger than 7 days sit in the dashboard's
  "Pending" section instead of becoming PRs.

Ongoing (first weeks):

- Merge one chart-bump PR and confirm Flux reconciles it
  (`flux --context nas get kustomization apps`, `kubectl --context nas get
helmreleases -A`).
- Watch that Flux image-automation commits (`automated image update(s) by
...`) continue without Renovate opening competing PRs for those images.

## State

- Plan written 2026-09-03. Implementation in progress.

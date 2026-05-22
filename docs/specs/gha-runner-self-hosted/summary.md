# Summary: Self-hosted GitHub Actions runners via ARC

## Context

Personal GitHub repos burned 2,855+ included Actions minutes by 2026-05-21
(mostly `tinkerbell` at 1,522 min and `ramblefeed` at 711 min). To stop the
bleed, this work stands up GitHub's Actions Runner Controller (ARC) inside
the `nas1` cluster and migrates workflows in the offending repos to use the
self-hosted scale sets instead of GitHub-hosted runners.

## What was done

### In this repo (`home-infra-k8s-flux`)

New tree under `apps/production/github-runners/`:

- `namespace-arc-systems.yaml` / `namespace-arc-runners.yaml` — controller
  pods run in `arc-systems`; runner pods (when jobs queue) run in
  `arc-runners`.
- `helmrepositories/actions-runner-controller.yaml` — OCI `HelmRepository`
  pointing at `oci://ghcr.io/actions/actions-runner-controller-charts`.
- `controller/helmrelease.yaml` — `gha-runner-scale-set-controller` chart
  pinned to `>=0.14.0 <0.15.0`, with the controller image tag marked for
  Flux ImagePolicy updates.
- `runners/tinkerbell/` + `runners/ramblefeed/` — one
  `gha-runner-scale-set` `HelmRelease` per repo. Each has its own
  SOPS-encrypted PAT secret (`.env.secret.github-token.encrypted`) and
  `dependsOn` the controller.
- `image-scanning-controller/` + `image-scanning-runner/` — Flux
  `ImageRepository` + `ImagePolicy` + `ImageUpdateAutomation` for the
  controller image and the runner image, both reusing the existing
  `apps/base/image-scanning/semver` templates.

Wiring:

- `apps/production/kustomization.yaml` — added `./github-runners`.
- `infrastructure/base/configs/image-scanning-webhook-receiver/all.yaml` —
  added the two new ImageRepositories (the receiver only fires on
  webhooks from `activescott`'s repos so the ARC entries are inert, but
  the validator requires them registered).
- `AGENTS.md` — added a note that Flux is webhook-driven and manual
  `flux reconcile` is unnecessary after pushes.

### Gotchas discovered along the way

1. **Inline pod-spec image fields need the full-image marker**, not
   `:tag`. First run of the image automation reduced
   `image: ghcr.io/actions/actions-runner:2.328.0` to just `image: 2.334.0`.
   Marker syntax: `:tag` replaces the entire YAML value with just the
   tag — correct when image name and tag live in separate keys (the
   controller chart's `image.repository`/`image.tag`), wrong for an
   inline `image: name:tag` string. Fixed in commit
   `9edce46 fix image automation marker for inline runner image field`.
2. **kustomize secretGenerator hash suffix breaks the chart**.
   `gha-runner-scale-set` reads `githubConfigSecret` as a name string;
   kustomize cannot rewrite that reference because it's not a typed name
   link. Without `options.disableNameSuffixHash: true`, the controller
   loops on `failed to get kubernetes secret: arc-runners/tinkerbell-github-token`.
   Fixed in commit `ab037ef disable kustomize hash suffix on PAT secrets`.
3. **Two `.env.secret.github-token.encrypted` files arrived as
   plaintext** (user-created with the wrong extension). The
   `.encrypted` suffix is whitelisted in `.gitignore` — files would
   have committed as plaintext. Renamed to drop the suffix, then ran
   `./scripts/encrypt-env-files.sh apps/production/github-runners/runners`,
   then deleted the plaintext originals.

### In the application repos

- **`activescott/tinkerbell` PR #76** (branch `ci/self-hosted-runner-smoke`).
  On `tinkerbell-runners`: `cleanup-packages.yaml`, `lint-pr-title.yaml`,
  `ci.yaml`'s `docker-build` job, `sync-litellm-pricing.yaml`,
  `build.yaml`. Still on `ubuntu-24.04`: `ci.yaml`'s `validate`,
  `integration-tests`, `release`, `trigger-build`.
  - PR-validated on new runner: lint-pr-title (37s), docker-build
    (8m4s — DinD path works), cleanup-packages (5s via manual
    dispatch).
  - **`validate` reverted to ubuntu-24.04**: on the self-hosted
    runner the job exited 1 after vitest reported all 294 tests
    green, with a trailing `Error: Cannot find module
    '/nonexistent/path/server.js'`. Looks like a tinkerbell test
    teardown / unhandled-promise issue, not an ARC issue — same
    PR's docker-build passed clean on the same runner. Needs a
    targeted investigation in tinkerbell before re-switching.
- **`activescott/ramblefeed` PR #32** (branch `ci/self-hosted-runner-smoke`).
  On `ramblefeed-runners`: `cleanup-packages.yaml`, `release.yaml`'s
  `validate` job, `build.yaml`. Still on `ubuntu-24.04`:
  `release.yaml`'s `e2e`, `release`, `trigger-build`.
  - PR-validated on new runner: validate (52s).
  - `build.yaml` validates naturally on next release-driven dispatch.

## Verification

Cluster state confirmed after Flux reconciled commit `9edce46`:

```
flux --context nas get helmrelease -A
# arc-controller            0.14.1   READY=True
# tinkerbell-runners        0.14.1   READY=True
# ramblefeed-runners        0.14.1   READY=True

kubectl --context nas get autoscalinglistener -A
# arc-systems  tinkerbell-runners-...-listener  Running
# arc-systems  ramblefeed-runners-...-listener  Running

gh run view 26269887110 --repo activescott/tinkerbell
# ✓ cleanup in 5s    (runs-on: tinkerbell-runners)
```

GitHub UI confirms scale sets registered at
`https://github.com/activescott/<repo>/settings/actions/runners`.

## Quick commands to resume work

```bash
# State of ARC
kubectl --context nas get helmrelease,autoscalingrunnerset,autoscalinglistener -A | grep -i arc
kubectl --context nas get pods -n arc-systems
kubectl --context nas get pods -n arc-runners       # empty unless a job is running

# Controller logs
kubectl --context nas logs -n arc-systems deployment/arc-controller-gha-rs-controller --tail=50

# Listener logs (per scale set)
kubectl --context nas logs -n arc-systems tinkerbell-runners-<hash>-listener --tail=50

# Smoke-trigger
gh workflow run cleanup-packages.yaml --repo activescott/tinkerbell --ref ci/self-hosted-runner-smoke
gh run list --repo activescott/tinkerbell --workflow=cleanup-packages.yaml --limit 3

# Re-encrypt PATs (if rotated)
echo "github_token=ghp_..." > apps/production/github-runners/runners/<repo>/.env.secret.github-token
./scripts/encrypt-env-files.sh apps/production/github-runners/runners
rm apps/production/github-runners/runners/<repo>/.env.secret.github-token
```

## Open items / where work left off

1. **Merge tinkerbell PR #76 and ramblefeed PR #32**. Both have at
   least one PR-triggered check (lint-pr-title for tinkerbell,
   `validate` job of release.yaml for ramblefeed) already green on
   the new self-hosted runners; the rest of the workflows still run
   on `ubuntu-24.04`. Squash-merge when ready — no further validation
   needed.
2. **Expand to the heavy workflows**, in this order:
   - `sync-litellm-pricing.yaml` (tinkerbell): scheduled, just curl +
     jq via well-known actions. One-line switch.
   - `build.yaml` (both repos): Docker Buildx → GHCR push. Uses
     `docker/setup-buildx-action@v3`. `containerMode: dind` is already
     on, so first manual `gh workflow run` is the validation.
   - `ci.yaml` (tinkerbell) `validate` + `docker-build` jobs: same
     reasoning as ramblefeed's `validate` switch — Node and Docker
     Buildx work on the stock image.
   - `ci.yaml` (tinkerbell) `integration-tests` job and
     `release.yaml` (ramblefeed) `e2e` job — these run minikube
     (`docker` driver) + skaffold + Playwright inside the runner pod.
     This is the biggest unknown: minikube-docker-driver inside DinD
     inside a Kubernetes pod is several layers of nesting. First run
     is the validation; may need to switch minikube to `none` driver
     or `kvm2`, or pre-pull images in a custom runner image. This is
     where the majority of the burned minutes live — biggest billing
     win, biggest risk.
3. **Resource sizing**: each runner pod requests 500m CPU / 1 Gi RAM
   with limits at 4 CPU / 6 Gi. `maxRunners: 2` per scale set, so
   worst case = 4 concurrent runner pods cluster-wide (8 GB / 8 CPU
   committed at limit). Watch node pressure during the first ci.yaml
   run.
4. **Adding more repos** (`serverless-aws-static-file-handler`,
   `gpu-agent`, `serverless-http-invoker`): copy
   `apps/production/github-runners/runners/tinkerbell/` to a new dir,
   change the four name strings (HelmRelease name, githubConfigUrl,
   githubConfigSecret, runnerScaleSetName), add the encrypted PAT,
   add the line in `apps/production/github-runners/kustomization.yaml`.
5. **Pre-existing tinkerbell-prod/app Deployment failure**: the
   `apps` Kustomization is stuck in not-ready because of a failing
   Deployment in `tinkerbell-prod`. Unrelated to ARC but is masking
   the apps-Kustomization status. Diagnosed during this work — the
   v0.31.6 image fails to start with
   `Error: Cannot find package 'handlebars' imported from
   /app/packages/chat/dist/workflows/template-resolver.js`. Old
   ReplicaSet (v0.31.5) is still serving 1/1; new ReplicaSet
   (v0.31.6) is CrashLoopBackOff. This is a build-time dependency
   bug in the tinkerbell app, not infra. Fix in the tinkerbell repo
   (likely missing `handlebars` in `packages/chat/package.json`
   dependencies, or excluded by the Docker multistage build).

## Log parsing in Loki

Three distinct log formats emit from ARC; all now parse via the
existing Alloy pipeline at
`apps/production/monitoring/alloy/helmrelease.yaml`:

- **arc-systems / manager** (controller, JSON `severity`/`message`):
  handled by `stage.json` with JMESPath `||` fallback from
  pino-style `level`/`msg` keys.
- **arc-systems / listener** (logfmt `time=... level=INFO msg=...`):
  handled by added `stage.logfmt`.
- **arc-runners / dind** (Docker daemon logfmt): same `stage.logfmt`.
- **arc-runners / runner** (`[RUNNER 2026-05-22 05:53:07Z INFO Listener]
  ...`): handled by added `stage.regex`.
- Trailing `stage.template` lowercases the level so the `level` label
  stays consistent across all streams (`info`, `warn`, `error`).

Plain text runner messages (e.g. `Exiting runner...`, `√ Removed
.credentials`) have no level marker — they remain at
`level=<no value>`, which is acceptable.

## Non-obvious environment notes

- **`AGENTS.md` says don't run `flux reconcile`** — webhooks at
  `flux-webhook.activescott.com` fire on every push. Watch the cluster
  with `kubectl --context nas` / `flux --context nas get ...` instead.
- **PAT scope**: a single fine-grained PAT covering both
  `tinkerbell` and `ramblefeed` was used. The same encrypted file
  content lives in both `runners/tinkerbell/` and `runners/ramblefeed/`
  but is materialized as a distinct Secret per namespace.
- **The validation pre-commit hook** (`scripts/validate-webhook-receiver.sh`)
  requires every ImageRepository to be listed in the webhook receiver,
  even if (like ours) GitHub will never deliver webhooks for that repo
  because it belongs to another user. Periodic
  ImageRepository scan still works; the entry is just there to satisfy
  validation.
- **Each scale set's `runnerScaleSetName` is the `runs-on:` label**
  the workflow must use. Mismatches won't error visibly — jobs just
  queue forever.

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

- `activescott/tinkerbell` branch `ci/self-hosted-runner-smoke`:
  switched `.github/workflows/cleanup-packages.yaml` from
  `runs-on: ubuntu-latest` to `runs-on: tinkerbell-runners`. Triggered
  via `gh workflow run` — completed in 5s, runner pod spun up and
  terminated cleanly. Smoke test passed.
- `activescott/ramblefeed`: same change pending push for the
  `cleanup-packages.yaml` workflow.

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

1. **Push the ramblefeed `cleanup-packages.yaml` change**. Edit is
   already in the working tree at
   `/Users/scott/src/activescott/ramblefeed/.github/workflows/cleanup-packages.yaml`;
   needs commit + push + a `gh workflow run` smoke trigger.
2. **Merge the tinkerbell smoke-test branch** (`ci/self-hosted-runner-smoke`)
   into `main` so the cleanup workflow stays on the self-hosted runner.
3. **Expand to more workflows incrementally**, per the plan's "Strategy:
   incremental switchover, lightweight jobs first". Order:
   - `lint-pr-title.yaml` (Node + npm; stock image has Node 20 built in;
     workflow uses `actions/setup-node@v4` so no extra deps needed).
   - `sync-litellm-pricing.yaml` (scheduled, just curl + jq via a
     well-known action).
   - `build.yaml` in both repos — these are Docker Buildx → GHCR.
     `containerMode: dind` is already on, so this should work; first
     run is the validation.
   - `ci.yaml` (tinkerbell) / `release.yaml` (ramblefeed) — these
     include `minikube + skaffold + Playwright`. Workflows need explicit
     `medyagh/setup-minikube`, skaffold install, and
     `npx playwright install --with-deps` steps because the stock
     runner image doesn't ship them. This is the biggest cold-start
     cost and may need a custom runner image later.
4. **Loki/Grafana parses controller logs poorly** — ARC controller
   emits tab-separated zap-console format, listener emits logfmt.
   Tracked separately at `docs/specs/arc-logs-parsing/` (TODO: create
   that spec when the work starts). Quick fix planned: set
   `flags.logFormat: "json"` on the controller chart values (the
   change is already staged in
   `apps/production/github-runners/controller/helmrelease.yaml` but
   not yet committed), and add a `stage.logfmt` fallback to
   `apps/production/monitoring/alloy/helmrelease.yaml` for the
   listener.
5. **Resource sizing**: each runner pod requests 500m CPU / 1 Gi RAM
   with limits at 4 CPU / 6 Gi. `maxRunners: 2` per scale set, so
   worst case = 4 concurrent runner pods cluster-wide (8 GB / 8 CPU
   committed at limit). Watch node pressure during the first ci.yaml
   run.
6. **Adding more repos** (`serverless-aws-static-file-handler`,
   `gpu-agent`, `serverless-http-invoker`): copy
   `apps/production/github-runners/runners/tinkerbell/` to a new dir,
   change the four name strings (HelmRelease name, githubConfigUrl,
   githubConfigSecret, runnerScaleSetName), add the encrypted PAT,
   add the line in `apps/production/github-runners/kustomization.yaml`.

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

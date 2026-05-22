# Plan: Self-hosted GitHub Actions runners on `nas1` cluster via Flux

## Context

Personal GitHub repos burned 2,855 included Actions minutes by 2026-05-21, with `tinkerbell` (1,522 min) and `ramblefeed` (711 min) accounting for ~78% of usage. We will run self-hosted GitHub Actions runners inside the existing `nas1` k3s cluster, managed via Flux GitOps in this repo, so those minutes stop coming out of the GitHub-hosted allowance.

We will:
- Deploy GitHub's **Actions Runner Controller (ARC)** with **gha-runner-scale-set** (the modern, GitHub-supported path).
- Register one **scale set per repo** (starting with `tinkerbell` and `ramblefeed`), structured so adding the next repo is a 1-file change.
- Use the **stock `ghcr.io/actions/actions-runner` image** and have workflows install Node/minikube/skaffold/Playwright at startup (no custom image to maintain).
- Wire up **Flux ImageRepository/ImagePolicy/ImageUpdateAutomation** for both the controller image and the runner image so they auto-update.

### Background concepts

- **ARC (Actions Runner Controller)** is a Kubernetes operator from GitHub that runs self-hosted runners as pods. A controller pod watches GitHub for queued jobs and creates ephemeral runner pods on demand. When a job finishes, the pod is destroyed — no long-lived runner processes.
- **Scale set** is one logical pool of runners registered to a single scope (a specific repo, an org, or an enterprise). Each scale set gets a name (e.g. `tinkerbell-runners`) which is what workflows reference via `runs-on:`. One controller can manage many scale sets.
- **Per-repo scope** means each repo has its own scale set with its own PAT (or shared PAT with `repo` scope across multiple repos). ARC does **not** support personal-user-account scope — only repo / org / enterprise.

### Constraints learned during exploration

- Workflows currently run on `ubuntu-24.04` / `ubuntu-latest`. After switch, each repo's workflow must be edited to `runs-on: <scale-set-name>`. That part is per-repo and out of scope for this k8s setup (we'll list it as a follow-up in each repo).
- `tinkerbell` and `ramblefeed` use minikube + skaffold for e2e — they need **Docker-in-Docker** in the runner pod. Use `containerMode: dind`.
- Single-node cluster (`nas`). Storage uses local hostPath under `/mnt/thedatapool/app-data/`.
- ARC chart is delivered as an **OCI Helm chart**: `oci://ghcr.io/actions/actions-runner-controller-charts/{gha-runner-scale-set-controller,gha-runner-scale-set}`. Latest: `0.14.1`.

## Architecture

```
flux apps
└── apps/production/github-runners/
    ├── namespace-arc-systems.yaml      # controller namespace
    ├── namespace-arc-runners.yaml      # runner pods namespace
    ├── kustomization.yaml              # imports controller + each runner subdir
    ├── helmrepositories/
    │   └── gha-runner-scale-set.yaml   # OCI HelmRepository
    ├── controller/
    │   ├── kustomization.yaml
    │   └── helmrelease.yaml            # gha-runner-scale-set-controller
    ├── runners/
    │   ├── tinkerbell/
    │   │   ├── kustomization.yaml
    │   │   ├── helmrelease.yaml        # scale set for tinkerbell
    │   │   └── .env.secret.github-token.encrypted
    │   └── ramblefeed/
    │       ├── kustomization.yaml
    │       ├── helmrelease.yaml
    │       └── .env.secret.github-token.encrypted
    ├── image-scanning-controller/      # auto-updates controller image
    │   └── kustomization.yaml
    └── image-scanning-runner/          # auto-updates runner image
        └── kustomization.yaml
```

Add `- ./github-runners` to `apps/production/kustomization.yaml`.

### Why two namespaces

GitHub's docs recommend isolating controller pods (`arc-systems`) from runner pods (`arc-runners`) for blast radius — a compromised runner can't see controller secrets. We'll follow the convention.

### Why an OCI HelmRepository (not raw OCI URL)

The chart is published to `ghcr.io/actions/actions-runner-controller-charts/*`. We declare it once as a `HelmRepository` with `type: oci` and reference it from both HelmReleases (controller + each runner scale set). This matches the pattern in `apps/production/monitoring/helmrepositories/`.

## Detailed components

### 1. PAT setup (manual, one-time per repo)

For each repo (`tinkerbell`, `ramblefeed`), create a **classic PAT** with `repo` scope (or fine-grained PAT with Actions: read+write and Administration: read+write on the specific repo). The PAT is stored as a SOPS-encrypted env file:

```
runners/tinkerbell/.env.secret.github-token.encrypted
runners/ramblefeed/.env.secret.github-token.encrypted
```

Each file contains: `github_token=ghp_xxxxx`

The `secretGenerator` in each runner's `kustomization.yaml` materializes this as a Secret named e.g. `tinkerbell-github-token`, which the HelmRelease references via `githubConfigSecret: tinkerbell-github-token`.

**Note**: One PAT per repo is the simplest. Could share a single PAT across both repos (same `repo` scope on each), but keeping them per-repo limits blast radius.

### 2. HelmRepository

`apps/production/github-runners/helmrepositories/gha-runner-scale-set.yaml`:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: actions-runner-controller
  namespace: arc-systems
spec:
  interval: 24h
  type: oci
  url: oci://ghcr.io/actions/actions-runner-controller-charts
```

### 3. Controller HelmRelease

`apps/production/github-runners/controller/helmrelease.yaml`:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: arc-controller
  namespace: arc-systems
spec:
  interval: 1h
  chart:
    spec:
      chart: gha-runner-scale-set-controller
      version: ">=0.14.0 <0.15.0"   # auto-pick patch releases in the 0.14.x line
      sourceRef:
        kind: HelmRepository
        name: actions-runner-controller
        namespace: arc-systems
  values:
    image:
      repository: ghcr.io/actions/gha-runner-scale-set-controller
      tag: "0.14.1"  # {"$imagepolicy": "arc-systems:policy-arc-controller:tag"}
    flags:
      watchSingleNamespace: arc-runners
```

The `version:` range gives us auto-updates of patch versions of the chart. The image `tag:` is independently auto-updated by Flux ImagePolicy markers.

### 4. Per-repo scale set HelmRelease (template)

`apps/production/github-runners/runners/tinkerbell/helmrelease.yaml`:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: tinkerbell-runners
  namespace: arc-runners
spec:
  interval: 1h
  chart:
    spec:
      chart: gha-runner-scale-set
      version: ">=0.14.0 <0.15.0"
      sourceRef:
        kind: HelmRepository
        name: actions-runner-controller
        namespace: arc-systems
  values:
    githubConfigUrl: https://github.com/activescott/tinkerbell
    githubConfigSecret: tinkerbell-github-token
    runnerScaleSetName: tinkerbell-runners
    minRunners: 0
    maxRunners: 2
    containerMode:
      type: dind
    template:
      spec:
        containers:
          - name: runner
            image: ghcr.io/actions/actions-runner:2.328.0  # {"$imagepolicy": "arc-runners:policy-actions-runner:tag"}
            command: ["/home/runner/run.sh"]
            resources:
              requests:
                cpu: "500m"
                memory: "1Gi"
              limits:
                cpu: "4"
                memory: "6Gi"
```

`apps/production/github-runners/runners/tinkerbell/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: arc-runners
resources:
  - helmrelease.yaml
secretGenerator:
  - name: tinkerbell-github-token
    envs:
      - .env.secret.github-token.encrypted
```

To add a 3rd repo later: copy `runners/tinkerbell/` to `runners/<new-repo>/`, change three string values (HelmRelease name, githubConfigUrl, runnerScaleSetName, secret name), add the encrypted PAT file, and add the line to `apps/production/github-runners/kustomization.yaml`.

### 5. Image automation

Two ImagePolicy/ImageRepository pairs, both reusing existing `apps/base/image-scanning/semver` base templates:

**`image-scanning-controller/kustomization.yaml`** — scans `ghcr.io/actions/gha-runner-scale-set-controller`, range `>=0.14.0 <0.15.0`. Writes to the `tag:` marker in `controller/helmrelease.yaml`.

**`image-scanning-runner/kustomization.yaml`** — scans `ghcr.io/actions/actions-runner`, range `>=2.0.0`. Writes to the `tag:` markers in every `runners/*/helmrelease.yaml`.

The existing `ImageUpdateAutomation` machinery (used by `tinkerbell-prod/update-tinkerbell-app` etc. — see recent commits in `git log`) will pick these up automatically since it scans the whole repo. Note: both ARC images are public on ghcr.io, so no pull-secret is needed for scanning.

### 6. Workflow changes in each repo (final stage — completes the goal)

After ARC is deployed and verified healthy on the cluster, switch the actual workflows over so jobs run on the self-hosted runners instead of GitHub-hosted ones. This is what closes the loop on the billing problem.

**Strategy: incremental switchover, lightweight jobs first.**

Order of operations per repo:

1. **Start with the cheapest workflow** to validate the runner works at all:
   - `tinkerbell`: `.github/workflows/lint-pr-title.yaml` (just commitlint, no Docker)
   - `ramblefeed`: pick the smallest job in `release.yaml` (the validate job)

2. **Edit one job's `runs-on:`** on a branch:
   ```diff
   - runs-on: ubuntu-24.04
   + runs-on: tinkerbell-runners   # or ramblefeed-runners
   ```

3. **Open PR, watch it run** (see Verification §4). If green, merge.

4. **Then expand** to the heavier workflows in the same repo:
   - `tinkerbell`: `ci.yaml` (validate → integration-tests → docker-build), `build.yaml`, `cleanup-packages.yaml`, `sync-litellm-pricing.yaml`
   - `ramblefeed`: `build.yaml`, `cleanup-packages.yaml`, the full `release.yaml`

5. **For each workflow**, before switching, confirm tool needs are covered:
   - `actions/setup-node@v5` — works as-is on stock ubuntu runner image.
   - Docker / Buildx — already in the runner pod via `containerMode: dind`.
   - **minikube + skaffold** (tinkerbell `ci.yaml` integration-tests, ramblefeed `release.yaml` e2e) — add explicit install steps before use:
     ```yaml
     - uses: medyagh/setup-minikube@latest
     - uses: hiberbee/github-action-skaffold@latest
     ```
     or curl/apt installs. This is the biggest cold-start cost.
   - **Playwright browsers** — `npx playwright install --with-deps firefox` (and webkit for ramblefeed) needs `sudo` on the runner. The stock `ghcr.io/actions/actions-runner` image runs as a non-root `runner` user with passwordless sudo, so `--with-deps` works.
   - **AWS OIDC** (serverless-aws-static-file-handler, later) — `aws-actions/configure-aws-credentials@v5` uses GitHub's OIDC token endpoint which works identically from self-hosted runners; no extra config needed.

6. **Per-PR verification loop** for each switched workflow:
   - Watch `kubectl --context nas -n arc-runners get pods -w` — a runner pod should spin up for the job and terminate after.
   - Confirm job completes green in GitHub's PR checks UI.
   - If a job fails for missing tools, add the install step and re-run before moving to the next workflow.

7. **Commit the switchover changes per-repo** (these PRs land in the `tinkerbell` and `ramblefeed` repos, NOT in this Flux repo).

8. **Final confirmation** — after a few days of activity (or by manually triggering a workflow), check GitHub Billing → Plans & usage → Actions usage page. New Actions Linux minutes added to `tinkerbell` and `ramblefeed` should be ~0.

## Files to create

1. `apps/production/github-runners/namespace-arc-systems.yaml`
2. `apps/production/github-runners/namespace-arc-runners.yaml`
3. `apps/production/github-runners/kustomization.yaml`
4. `apps/production/github-runners/helmrepositories/kustomization.yaml`
5. `apps/production/github-runners/helmrepositories/gha-runner-scale-set.yaml`
6. `apps/production/github-runners/controller/kustomization.yaml`
7. `apps/production/github-runners/controller/helmrelease.yaml`
8. `apps/production/github-runners/runners/tinkerbell/kustomization.yaml`
9. `apps/production/github-runners/runners/tinkerbell/helmrelease.yaml`
10. `apps/production/github-runners/runners/tinkerbell/.env.secret.github-token.encrypted` (SOPS-encrypted)
11. `apps/production/github-runners/runners/ramblefeed/kustomization.yaml`
12. `apps/production/github-runners/runners/ramblefeed/helmrelease.yaml`
13. `apps/production/github-runners/runners/ramblefeed/.env.secret.github-token.encrypted` (SOPS-encrypted)
14. `apps/production/github-runners/image-scanning-controller/kustomization.yaml`
15. `apps/production/github-runners/image-scanning-runner/kustomization.yaml`

## Files to modify

- `apps/production/kustomization.yaml` — add `- ./github-runners` to the resources list.

## Verification

1. **Flux reconciles cleanly**:
   ```
   flux --context nas reconcile kustomization apps --with-source
   flux --context nas get helmreleases -A | grep -E 'arc-controller|tinkerbell-runners|ramblefeed-runners'
   ```
   All three should show `READY: True`.

2. **Controller and listener pods are running**:
   ```
   kubectl --context nas -n arc-systems get pods
   kubectl --context nas -n arc-runners get pods    # should show listener pods, idle (no runner pods until a job queues)
   ```

3. **Scale set appears in GitHub UI** at `https://github.com/activescott/tinkerbell/settings/actions/runners` — confirm a runner group / scale set named `tinkerbell-runners` is listed.

4. **End-to-end smoke**: in the `tinkerbell` repo, on a branch, change `runs-on: ubuntu-24.04` to `runs-on: tinkerbell-runners` in one cheap job (`lint-pr-title.yaml`), push, open PR. Watch:
   ```
   kubectl --context nas -n arc-runners get pods -w
   ```
   A runner pod should be created, run the job, and disappear. Confirm the job completes green in GitHub.

5. **Image automation works**: after first reconcile, check:
   ```
   flux --context nas get image policy -A
   flux --context nas get image repository -A
   ```
   Both new policies should resolve to the current latest semver tags.

6. **Cost confirmation** (in ~24h, after a few PRs): GitHub billing page should show 0 additional Actions Linux minutes for `tinkerbell` and `ramblefeed`.

## Out of scope (follow-ups)

- Custom runner image with minikube/skaffold/Playwright baked in (optimization for later if cold-start install is too slow).
- Org-level scale set (would require moving repos under a GitHub org).
- Persistent runner cache (PVC for `~/.npm`, Docker layer cache) — would speed builds but adds complexity.
- Adding the remaining lower-burn repos (`serverless-aws-static-file-handler`, `gpu-agent`, `serverless-http-invoker`) — same pattern: copy a `runners/<repo>/` directory and add its PAT.

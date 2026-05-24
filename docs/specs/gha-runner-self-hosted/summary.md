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
4. **`listenerTemplate.spec.containers` is required by the chart's
   AutoscalingListener CRD** even when you only want to add
   `metadata.annotations`. Adding metadata-only first caused
   `AutoscalingListener.actions.github.com is invalid:
   spec.template.spec.containers: Required value` and listener pods
   stopped being created. Fix: include `containers: [{ name: listener }]`
   in `listenerTemplate.spec`. The container name matters — if it
   isn't `listener`, the chart treats it as a side-car instead of
   merging onto the listener container's default config.

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

1. **DONE**: tinkerbell PR #76 (merged 2026-05-22 17:45 UTC) and
   ramblefeed PR #32 (merged 2026-05-23 01:00 UTC). Subsequent
   migrations:
   - tinkerbell PR #82 — moved all remaining `ci.yaml` jobs
     (`validate`, `integration-tests`, `docker-build`, `release`,
     `trigger-build`) to `tinkerbell-runners`. Merged; latest run on
     main has `integration-tests` failing with the same
     "294 tests pass then exit 1" symptom that caused the original
     `validate` revert. Looks like a tinkerbell-side teardown bug;
     not yet fixed.
   - ramblefeed PR #34 — moved `release` and `trigger-build` jobs to
     `ramblefeed-runners`. Attempted `e2e` too and reverted it; see
     the "ramblefeed `e2e`: self-hosted spike" section below.
2. **`e2e` (ramblefeed) and `integration-tests` (tinkerbell) remain
   on / failing on self-hosted**. Both involve nested container
   runtimes (`e2e` via minikube; `integration-tests` may or may not —
   needs the tinkerbell exit-1 root-caused first). See the
   "ramblefeed `e2e`: self-hosted spike" section for the investigation
   so far, hypotheses, and success criteria. These are still the
   biggest billing win, biggest risk items.

   **Update (2026-05-23, ramblefeed)**: see "ramblefeed `e2e`:
   kind-on-self-hosted iteration" section below. ramblefeed migrated
   local dev + e2e CI from minikube to kind ([activescott/ramblefeed#35](https://github.com/activescott/ramblefeed/pull/35)).
   First CI attempt on `ramblefeed-runners` failed with kubeadm's own
   verdict `kubelet is unhealthy ... required cgroups disabled` —
   exact match to this doc's "What would actually break the deadlock"
   prediction. Mitigation: PR #6 in this repo adds
   `--exec-opt native.cgroupdriver=systemd` to the ramblefeed-runners
   dind sidecar.
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

## ramblefeed `e2e`: self-hosted spike (2026-05-23)

Ramblefeed PR #34 migrated `release.yaml`'s `release` and
`trigger-build` jobs to `ramblefeed-runners` (low risk; same Node-only
pattern as `validate`). It also tried `e2e` and reverted it back to
`ubuntu-24.04` after two failing runs. The `e2e` revert is documented
inline in `.github/workflows/release.yaml` (comment pointing to PR #34).

### What was tried

Two CI runs on `ramblefeed-runners`:

1. **Run `26321726597`** — `runs-on: ramblefeed-runners`, no other
   change to the e2e step. `Setup minikube` step ran
   `minikube start --driver docker --addons ingress,ingress-dns --wait all`
   and failed at the inner kubeadm step:
   `[kubelet-check] The kubelet is not healthy after 4m0.000669451s`
   Total step time ≈ 7 min (dominated by ~520 MiB kicbase image pull).
   minikube exited 109.
2. **Run `26322255627`** — added
   `start-args: --force-systemd=true --extra-config=kubelet.cgroup-driver=systemd`
   to the `medyagh/setup-minikube` step (the literal flag minikube
   suggests in its own error message; see
   <https://github.com/kubernetes/minikube/issues/4172>). Behavior
   shifted: first kubeadm attempt still timed out on `kubelet healthz`,
   but the internal retry got the control plane partway up. The job
   then hung in `Enabling 'ingress' returned an error: running
   callbacks: [waiting for app.kubernetes.io/name=ingress-nginx pods:
   context deadline exceeded]` and minikube exited 80 at
   `GUEST_START: extra waiting: WaitExtra: context deadline exceeded`.
   Total step time ≈ 26 min.

`validate` (same workflow, same scale set) passed in both runs (~1 min),
so the runner pod and DinD sidecar themselves are healthy — the failure
is specifically in nested-kube startup.

### Why this works on GitHub-hosted runners and not on ours

GitHub-hosted `ubuntu-24.04` is a **VM** (Azure-provided), not a
container. The layering when minikube docker driver runs there is:

```
Azure VM (real kernel, systemd PID 1, full /dev /sys /proc)
  └─ host dockerd (installed in the image)
       └─ minikube kic node container (its own systemd + containerd)
            └─ kubelet + control-plane static pods
```

On our self-hosted ARC scale set the layering is:

```
TrueNAS host (kernel 5.15.131+truenas, k3s node)
  └─ runner pod  (no systemd; runner user; container)
  └─ DinD sidecar pod-container (privileged; running dockerd as PID ~1)
       └─ minikube kic node container
            └─ kubelet + control-plane static pods
```

Concrete differences that plausibly explain the failure:

1. **Two extra layers of container nesting**. Even when each `dockerd`
   is privileged, cgroup paths, namespace mounts, and `/proc`
   visibility get progressively quirkier. The kic node's kubelet
   talking to its own container runtime sometimes fails to set up
   the pod sandbox cgroup correctly.
2. **No outer systemd**. The DinD sidecar runs `dockerd` directly as
   PID ~1, not under systemd. The kic node container *does* include
   systemd, but kubelet expects coherent cgroup driver alignment
   between itself, the container runtime, and the host init —
   harder to achieve here. `--force-systemd` only sets the kic-side
   driver; if the DinD layer below is on cgroupfs, the alignment
   still breaks.
3. **TrueNAS-patched kernel**. `5.15.131+truenas` is missing the
   `configs` module (kubeadm preflight printed
   `modprobe: FATAL: Module configs not found in directory
   /lib/modules/5.15.131+truenas`). The warning itself is non-fatal,
   but TrueNAS often disables or rebuilds other modules
   (kernel namespaces, `binfmt_misc`, BPF-related). Some of those are
   load-bearing for nested kubelet startup. The Azure kernel has
   everything stock kubeadm expects.
4. **minikube ingress addon assumes a real Service of type
   LoadBalancer with an external IP**. On GitHub VMs that IP comes
   from `minikube tunnel` (or the addon's NodePort fallback); inside
   our nested setup, the ingress-controller pod itself never
   reconciles to Ready in run 2, so even partial control-plane
   success doesn't unblock the addon.

### Hypotheses worth testing (not ranked, all carry risk)

- **`kind` instead of `minikube`**. `helm/kind-action` uses
  containerd-in-docker by design and is much more commonly used in
  CI nested setups. Would require a `kind` cluster spin-up,
  installing the nginx ingress controller via Helm/manifest (kind
  has no built-in ingress addon), and adjusting `scripts/dev` /
  skaffold profile to target the kind context. Open question: does
  the same nesting issue bite kind, just with different symptoms?
- **`minikube --driver=none`** with a custom runner image. The `none`
  driver runs Kubernetes binaries directly on the host (= the runner
  pod), no inner docker layer. Removes nesting entirely but requires
  the runner pod to ship with `crictl`, `conntrack`, `cri-dockerd` /
  containerd, `socat`, `ethtool`, `iptables`, and systemd-or-equivalent
  cgroup management. Means building a custom `gha-runner-scale-set`
  runner image (Dockerfile baked off the upstream
  `ghcr.io/actions/actions-runner` and published to GHCR), tracked by
  Flux ImageRepository just like the controller image.
- **Drop minikube/skaffold entirely; target the host cluster**. The
  runner already has cluster credentials (it lives in the cluster).
  Build the app image with `docker/build-push-action`, deploy to a
  per-PR namespace via `kubectl apply -k k8s/overlays/ci/<sha>` (new
  overlay), `wait` for readiness, run Playwright against the
  per-PR DNS name through the cluster's existing ingress, tear down.
  Largest workflow + scripts change, but trades nesting for
  infrastructure we already operate.
- **Pre-build a runner image with kicbase + Kubernetes images
  pre-pulled**. Cuts the ~7-minute kicbase pull at every run. Does
  not address the kubelet-healthz timeout root cause, so this is at
  best a follow-on optimization once a working configuration exists.
- **A different cgroup configuration on the DinD sidecar**. The ARC
  chart's dind container could be customized via
  `template.spec.containers[name=dind]` overrides to enable
  systemd-cgroup mode in dockerd
  (`--exec-opt native.cgroupdriver=systemd`) and matching args on
  the runner. Cheap to try; may or may not be sufficient on this
  kernel.

### Success criteria for any solution

- `e2e` job completes within the existing 30-minute timeout on
  `ramblefeed-runners`, with Playwright tests running against a
  deployed copy of the app under realistic ingress routing.
- No new privileged-host-mount requirement beyond what `containerMode:
  dind` already grants (which is privileged-ish already, so this is a
  low bar).
- Doesn't require manual maintenance per release of minikube/kind/k8s
  beyond what we'd accept for tinkerbell's `integration-tests` (which
  has the same nesting shape, see below).

### What would actually break the deadlock

Both runs hung at the same point: the inner kubelet waited on its own
`healthz` and timed out. The hypotheses above attack peripheral things
(image bloat, version pinning, cgroup args). The cgroup-delegation
chain analysis suggests something more pointed: kubelet inside kic can't
get the cgroup subtree it needs because **the two layers above it —
the ARC runner pod and the DinD sidecar — provide no systemd to
delegate cgroup ownership down**. `--force-systemd` only changes
kubelet's driver inside kic; it doesn't create a systemd in the layers
above to ask. Approaches that attack that specific assumption rather
than the symptoms:

- **Replace minikube with `kind`**. kind is engineered around "the node
  *is* a container." There's no inner kic-node container and no second
  dockerd underneath the DinD sidecar's dockerd. The chain becomes
  runner-pod → DinD-dockerd → kind-node (kubelet inside that one
  container, no further nesting). One fewer cgroup delegation hop,
  much higher odds of working. kind has no built-in ingress addon, so
  the workflow would also Helm-install nginx-ingress. This is the
  standard approach in GitHub Actions for "I need a kube cluster"
  inside DinD and is documented to work.
- **Switch this scale set to `containerMode: kubernetes`** instead of
  `dind`. ARC's `kubernetes` container mode drops the DinD sidecar
  entirely and gives the runner pod direct access to the *host*
  Kubernetes API (the same `nas1` cluster). Tests that need a cluster
  use the cluster they're already in, via a per-PR namespace
  (`kubectl apply -k k8s/overlays/ci/<sha>`) and the existing
  ingress controller. The cost is losing docker-in-docker for image
  builds — but ramblefeed's `build.yaml` and tinkerbell's
  `docker-build` are separate workflows and can keep using a
  DinD-mode runner if needed (two scale sets per repo, one for
  `e2e`/`integration-tests`, one for builds). This stops fighting the
  nesting entirely.
- **Inject a systemd shim in the runner pod and configure DinD with
  `--exec-opt native.cgroupdriver=systemd`**. Cheap to try; provides
  the missing middle-layer systemd that the kic kubelet's
  delegation chain expects. Likely still brittle but worth one shot
  if neither of the above is workable.

Out of scope for both `kind` and `containerMode: kubernetes`: minikube
itself is no longer used, so any ramblefeed-side reliance on
minikube-specific behavior (ingress addon DNS, mount-host-files, etc.)
becomes part of the migration cost.

### Related: tinkerbell `integration-tests` may have a similar story

Tinkerbell PR #82 moved `integration-tests` to `tinkerbell-runners` and
it currently fails on main with all 294 vitest tests green plus a
trailing exit 1 (same symptom as the original `validate` failure that
was reverted in PR #76). Worth checking whether the actual failing
process is itself spinning up something that nests (or whether it's
just an unhandled-promise teardown bug in the test harness) before
attacking the ramblefeed `e2e` case — the cheaper fix may live in the
tinkerbell repo.

## Telemetry & dashboard

A Grafana dashboard "Github Actions Self-hosted Runners" is provisioned
under the `GitHub Actions` folder (Flux-managed via the existing
sidecar pattern at
`apps/production/monitoring/grafana/dashboards/github-actions-runners.json`).

Per-dashboard folder routing is now enabled cluster-wide: the Grafana
sidecar has `folderAnnotation: grafana_folder`, and each dashboard
ConfigMap sets that annotation in its kustomization (e.g.
`grafana_folder: GitHub Actions`). Dashboards without an annotation
land in a `Dashboards` default.

**ARC metrics opt-in** — both ARC charts gate metrics behind values
that are commented out by default. Now enabled:

- `gha-runner-scale-set-controller` chart: `metrics:` block bound to
  `:8080/metrics`, with `prometheus.io/scrape` pod annotations so the
  existing `kubernetes-pods` Prometheus job picks it up. Emits
  `gha_controller_running_listeners`,
  `gha_controller_running_ephemeral_runners`,
  `gha_controller_failed_ephemeral_runners`,
  `gha_controller_pending_ephemeral_runners` — all labeled by
  `name`/`namespace`/`repository`.
- `gha-runner-scale-set` chart (per scale set): `listenerMetrics:`
  block uncommented with the chart's documented label sets; the
  listener pod now emits `gha_started_jobs_total`,
  `gha_completed_jobs_total` (with the `job_result` label —
  succeeded/failed/cancelled), `gha_running_jobs`,
  `gha_busy_runners`, `gha_idle_runners`, `gha_registered_runners`,
  `gha_min_runners`/`gha_max_runners`/`gha_desired_runners`,
  `gha_job_startup_duration_seconds`, and
  `gha_job_execution_duration_seconds`. `listenerTemplate.spec` must
  include a `name: listener` container (empty otherwise) when
  `metadata.annotations` is set, otherwise the chart's
  AutoscalingListener CRD validation fails — see the gotchas list
  below.

Dashboard panels:

- Stats: controller, listener, active runner pods, completed runners
  in last 24h.
- Jobs (listener metrics): completed jobs by result, running jobs
  gauge, job start rate, p50/p95 startup + execution duration
  histograms.
- Runner activity: concurrent running runner pods by scale set
  (regex `label_replace` from pod name).
- Resource usage: CPU and memory per pod across both namespaces.
- Logs: controller/listener warnings & errors, full runner-pod
  log stream.

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

## ramblefeed `e2e`: kind-on-self-hosted iteration (2026-05-23)

ramblefeed PR [#35](https://github.com/activescott/ramblefeed/pull/35)
migrates local dev + the `e2e` job from minikube to kind, with `e2e`
also moving from `ubuntu-24.04` to `ramblefeed-runners`. See
ramblefeed `specs/migrate-dev-to-kind/` for the migration spec; the
self-hosted runner iteration is summarized here so future repos
(tinkerbell `integration-tests`, etc.) inherit the lessons.

### What was tried (this iteration)

1. **Run [`26340785844`](https://github.com/activescott/ramblefeed/actions/runs/26340785844)** —
   `runs-on: ramblefeed-runners` + `helm/kind-action@v1` with default
   `wait: 120s`, `verbosity: 0`. `Setup kind` step *completed with a
   warning* (`Waiting <= 2m0s for control-plane = Ready timed out`),
   then skaffold deployed and pods stayed `Pending` because the kind
   node was `NotReady` (auto `node.kubernetes.io/not-ready:NoSchedule`
   taint). Wait-on timed out at 10m. Total wall clock: ~19m.

2. **Run [`26348389705`](https://github.com/activescott/ramblefeed/actions/runs/26348389705)** —
   added a fast-fail `kubectl wait --for=condition=ready node` step,
   bumped `helm/kind-action` to `verbosity: 5` and `wait: 300s`, and
   expanded failure diagnostics to include `kind export logs`,
   `kubectl describe nodes`, and cluster-wide events. `Setup kind`
   now explicitly *failed* with kubeadm spelling it out:

   ```
   [kubelet-check] The kubelet is not healthy after 4m0.000833957s
     - The kubelet is not running
     - The kubelet is unhealthy due to a misconfiguration of the node
       in some way (required cgroups disabled)
   ```

   Total wall clock: ~6m. The diagnostic improvements are commit
   `103338e` in ramblefeed.

### Mitigation in flight

PR #6 in this repo overrides the chart-default dind sidecar args on
`ramblefeed-runners` to add `--exec-opt native.cgroupdriver=systemd`.
Args here REPLACE (not merge with) the chart default, so the chart's
`--host=unix:///run/docker/docker.sock` and `--group=$(DOCKER_GROUP_GID)`
flags must be kept verbatim; the chart docs are silent on this and the
only authoritative source is
`gha-runner-scale-set/templates/_helpers.tpl`.

### Reusable lessons

- **For nested kube on self-hosted ARC**: bump `helm/kind-action`
  `verbosity: 5` and `wait: 300s` by default; with the chart defaults,
  kind silently "succeeds" with a Ready-timeout warning and the real
  failure surfaces much later.
- **Always add a fast-fail `kubectl wait --for=condition=ready node`
  step** between Setup kind and any wait-on for app readiness. It cut
  failed-run wall clock from 19m to 6m here.
- **Always capture `kind export logs` on failure** — kubelet,
  containerd, and kube-system pod logs come together in one tarball,
  uploaded as an artifact. Without this you are flying blind.
- **dind args overrides are full replacements, not merges.** Copy the
  chart's default `--host=unix:///run/docker/docker.sock` and
  `--group=$(DOCKER_GROUP_GID)` into any override or dind will fail to
  start.
- **Tinkerbell `integration-tests` likely needs the same dind override**
  (cgroupdriver=systemd) if/when that work resumes.

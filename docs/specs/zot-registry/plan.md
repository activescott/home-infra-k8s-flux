# Plan: zot OCI registry (pull-through mirror + buildkit cache)

Tracks [activescott/home-infra-private#2](https://github.com/activescott/home-infra-private/issues/2)
(private repo — full acceptance criteria and motivating CI-timing data there).

## Problem

ramblefeed CI (self-hosted ARC runners on this cluster) re-pulls every image
from scratch into an ephemeral dind sidecar on every run and rebuilds the dev
image uncached — measured 5-8 minutes of redundant WAN pulls plus an
uncached `npm ci` layer per e2e run.

## Approach

Deploy `zot` (not Harbor, not `registry:2` — already decided in the issue)
as a single pod + PVC, serving two roles in one instance:
1. Pull-through mirror for docker.io/ghcr.io/registry.k8s.io/mcr.microsoft.com
   via zot's `sync` extension in on-demand mode.
2. Writable registry for buildkit `--cache-to type=registry` layer-cache
   pushes and locally built images.

TLS via cert-manager + Let's Encrypt at `oci-registry.activescott.com` — a
publicly-trusted cert means runner dind daemons and kind nodes trust the
registry with zero `--insecure-registry`/CA-plumbing config.

## Research corrections (verified against zot's upstream source)

A docs-only read of the chart's `values.yaml` is misleading on two points
that materially change the manifests:

- **`persistence: false` renders a Deployment with a hardcoded `emptyDir`**
  data volume (`templates/deployment.yaml`). A PVC only appears via
  **`persistence: true`**, which switches the chart to a **StatefulSet**
  (`templates/statefulset.yaml`). There, `pvc.create: false` + `pvc.name`
  mounts a hand-provisioned PVC — the StatefulSet-selecting combination is
  non-obvious from the values file alone.
- **`mountSecret`/`secretFiles` has no existing-secret mode.**
  `templates/secret.yaml` always builds a brand-new Secret from plaintext
  content embedded directly in `values:`. Using it for the Docker Hub
  credential or htpasswd would put the raw password in the committed
  HelmRelease YAML, defeating SOPS entirely. **Use `externalSecrets:
  [{secretName, mountPath}]` instead** — a purpose-built value for mounting
  pre-existing Secrets, which is what lets us keep secret material only in
  SOPS-encrypted files.

Other facts baked into the config below:
- `http.compat: ["docker2s2"]` is required — Docker Hub serves Docker
  manifest schema-2, not OCI; without this, pulls through the mirror are at
  best digest-mangled.
- `extensions.sync.credentialsFile`'s lookup key must equal `urls[0]`'s host
  **verbatim** — for `"urls": ["https://index.docker.io"]` the key is
  `index.docker.io` exactly. Wrong key fails *silently* (falls back to
  anonymous; only surfaces later as Hub rate-limit errors).
- Health probes (`/livez`, `/readyz`, `/startupz`) are registered before
  zot's auth middleware — no `authHeader` chart value needed, so no base64
  credentials sit in committed values.
- zot's container image runs as root (no `USER` in its Dockerfile) — no
  `chown` init step needed on the hostPath PV.
- **Retention policies are first-match-wins; access-control policies are
  longest-glob-wins** — opposite precedence. Mirror-repo retention policies
  must be declared *before* the `**` catch-all or it silently wins instead.
- Chart pin `0.1.122` (appVersion `v2.1.18`), repo
  `https://zotregistry.dev/helm-charts` — confirmed against the chart's own
  `index.yaml` as of 2026-08-07.

## URL layout (resolves the issue's `<mirror-path-for>` placeholder)

Path-namespaced by upstream hostname — one `sync.registries[]` entry per
upstream, `content: [{prefix: "**", destination: "/<upstream-host>"}]`. This
is zot's own recommended shape (`examples/config-popular-registries.json`).

| Client pulls | zot fetches from |
|---|---|
| `oci-registry.activescott.com/docker.io/library/postgres:16` | `index.docker.io/library/postgres:16` |
| `oci-registry.activescott.com/ghcr.io/actions/actions-runner:2.336.0` | `ghcr.io/actions/actions-runner:2.336.0` |
| `oci-registry.activescott.com/registry.k8s.io/ingress-nginx/controller:v1.11.2` | `registry.k8s.io/...` |
| `oci-registry.activescott.com/mcr.microsoft.com/playwright:v1.49.0-jammy` | `mcr.microsoft.com/...` |

**`<mirror-path-for>` = `docker.io`.** The four upstream-hostname prefixes
are reserved for sync; any other top-level path (e.g. `ramblefeed/buildcache`)
matches no sync content and behaves as an ordinary local read/write repo —
no collision by construction.

## Auth model

htpasswd (bcrypt), two accounts, zero anonymous access anywhere. The
registry is internet-exposed by design (that's the point of the public cert)
— anonymous read would let strangers burn the Docker Hub quota through this
account; anonymous write would let anyone poison the build cache.

- `mirror` — read-only on `**`. CI runner pods, kind nodes.
- `ci` — admin (read/create/update/delete on `**`). buildkit cache
  push/pull, locally built images.

No `anonymousPolicy` anywhere → denied everywhere. cert-manager's HTTP-01
challenge is unaffected (ingress-shim routes the ACME path via a separate
temporary rule before it reaches zot).

## Secret plumbing

Flux's kustomize-controller derives the SOPS decrypt format from the
`secretGenerator` **key**, not the filename:

| Secret | generator key | encrypted file | sops format | why |
|---|---|---|---|---|
| `zot-sync-credentials` | `credentials.json` | `zot-sync-credentials.json.encrypted` | json | key ends `.json` |
| `zot-htpasswd` | `htpasswd` | `zot-htpasswd.encrypted` | binary | no recognized extension → binary envelope, decrypts back to the raw multi-line file (needed for two `user:hash` lines) |

Both use `disableNameSuffixHash: true` so the HelmRelease references them by
a stable name via `externalSecrets`.

## config.json

See `apps/production/zot/helmrelease.yaml` for the live version (inlined
under `values.configFiles."config.json"`). Contains no secrets — only
paths/settings — safe to commit in plaintext.

Retention: mirror repos evict tags not pulled in 30 days; local/writable
repos keep the 20 most recent pushes within 90 days, subject to `gc: true` /
`gcInterval: 24h` actually reclaiming the space. **To change retention**,
edit `storage.retention.policies` in the HelmRelease's `config.json` block —
see the "Tuning retention" section in `apps/production/zot/README.md` for
the specific knobs and gotchas (policy order, `dryRun` for testing changes
safely).

No `pollInterval` on any sync registry (Hub rate-limits + has no catalog
listing — must stay on-demand only; pointless for the others in a pure
cache). No `extensions.search`/`metrics` — keeps attack surface down; the
metaDB that backs retention's `pulledWithin`/`mostRecentlyPushedCount` still
exists because `IsBasicAuthnEnabled() || IsRetentionEnabled()` is true
regardless of whether search is enabled.

## Manifest layout

No `apps/base/` split — single instance, matches `loki`/`cvat`/
`arize-phoenix` precedent. Everything under `apps/production/zot/`:

- `namespace.yaml` — `Namespace: zot-oci-registry`
- `helmrepository.yaml` — `HelmRepository` `zot` →
  `https://zotregistry.dev/helm-charts`
- `zot-pv.yaml` — hand-written PV+PVC (50Gi, RWO, `Retain`,
  `storageClassName: ""`, hostPath `/mnt/thedatapool/no-backup/app-data/zot`)
  — same tier as `loki`'s cache: large, ephemeral, fully reproducible, not
  worth backing up.
- `helmrelease.yaml` — the StatefulSet-selecting persistence combo, Traefik
  ingress class (chart defaults to `nginx`), annotation-driven cert (per
  `docs/specs/cert-management-standardization/plan.md` — no standalone
  `Certificate` for the same secretName, that combination caused
  `IncorrectCertificate` errors before), `externalSecrets` for both Secrets.
- `kustomization.yaml` — the `secretGenerator` with the exact keys
  `credentials.json` / `htpasswd` (renaming breaks SOPS format detection).
- `README.md` — client-facing: reserved-prefix table, both accounts, client
  recipes for the ramblefeed follow-up, retention-tuning pointers.

`apps/production/kustomization.yaml` gains `- ./zot`.

## Credential scripts

`scripts/create-zot-sync-credentials.sh` and `scripts/create-zot-htpasswd.sh`
mirror `scripts/create-image-pull-secret-ghcr.sh` structurally (prompt →
build → `sops -encrypt --age <pubkey>` → write into `apps/production/zot/`).
They hold no secrets themselves — only the operator's interactive input —
which is why they live here rather than in the private repo despite the
credential *identifiers* being tracked there
(`home-infra-private/inventory/registries.md`).

## DNS / cert sequencing

HTTP-01 requires the hostname to already resolve publicly before the
challenge can succeed — order matters:

1. User creates `oci-registry.activescott.com` DNS record, **grey-cloud /
   DNS-only, not proxied** (Cloudflare's proxy caps request body size and
   disallows proxying bulk binary content — a 2GB Playwright layer would
   fail through it). Confirms with `dig +short oci-registry.activescott.com @1.1.1.1`.
2. Commit + push the Phase-2 ciphertext and manifests **together** — if
   manifests land without the secrets, the StatefulSet crash-loops on a
   missing htpasswd path.
3. Flux reconciles via webhook (do not run `flux reconcile` manually).
4. Confirm Certificate `Ready=True` — if `IncorrectCertificate`, something
   created a second Certificate for the same secretName.

## Verification (maps to the issue's three acceptance criteria)

See `apps/production/zot/README.md` "Verification" section for the exact
commands (pull timing comparison, buildx cache round-trip, Hub ratelimit
header comparison). Note for the write-up: tag pulls always make one cheap
upstream manifest round-trip even when cached; digest pulls are fully
offline.

## Explicitly out of scope

- Persistent buildkitd remote-builder pod (issue: deferred).
- ramblefeed-side consumer wiring (buildx flags, kind containerd
  hosts.toml, CI preload steps) — separate follow-up in the app repo.
  `apps/production/zot/README.md` documents the URL layout so that work
  doesn't need to spelunk this repo.
- ~~In-cluster/LAN DNS shortcut to avoid WAN hairpinning on pulls~~ — done
  post-deploy: owner added an OPNsense/Unbound host override
  (`oci-registry.activescott.com` → the node IP), no Flux changes needed.
- ~~Prometheus metrics / Grafana dashboard for cache hit rate~~ — done
  post-deploy: `extensions.metrics` enabled (anonymous-readable `/metrics`,
  see the comment above `configFiles."config.json"` in helmrelease.yaml for
  why), `podAnnotations` added for this cluster's pod-annotation scrape
  convention, dashboard at
  `apps/production/monitoring/grafana/dashboards/zot-oci-registry.json`
  (usage, storage by repo, PVC %, GC/scheduler health, resource usage, logs).

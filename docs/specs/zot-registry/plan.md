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

## Redesign (2026-08-08): one zot instance per upstream

The single-instance, path-prefixed design below (kept for the record) shipped
and worked for direct `docker pull`/`curl` usage, but broke when actually
wiring it into CI: standard container-runtime "registry mirror" mechanisms —
Docker's `daemon.json` `registry-mirrors`, containerd's
`hosts.toml`/`containerdConfigPatches` — assume the mirror is a byte-for-byte
drop-in replacement for the origin, preserving the exact same
`/v2/<repo>/manifests/<ref>` path and just swapping the host. Neither
mechanism prepends anything like `/docker.io/` to the path, and containerd's
own docs confirm the actual behavior: a request through a configured mirror
host resolves to `https://<mirror>/v2/<repo>/manifests/<ref>?ns=<origin-host>`
— the original registry is passed as a **query parameter**, not folded into
the path. zot's `sync`/`content` routing has no concept of that `ns=`
parameter; it only understands the local path prefix from `content[].destination`,
which its own `content.go` (`getRepoSource`/`getRepoDestination`) uses to
map local↔remote repo names. So a client using standard mirror config against
the old single shared hostname would ask zot for `/v2/library/postgres/...`
with no `docker.io` anywhere in the request zot could see — no `content` rule
would ever match.

Fix: split into **one zot instance per upstream**, each its own hostname,
each `sync.registries[].content[].destination: "/"` (root — confirmed via
`content.go`: `strings.Trim("/", "/")` and `strings.Trim("", "/")` both yield
`""`, so omitting `destination` and setting it to `"/"` are identical, and
both mean "local repo path == remote repo path", i.e. a pure passthrough).
Each instance is now a genuine drop-in mirror target — standard tooling works
unmodified, no `ns=` parameter needed anywhere, no per-pull-site image
reference rewrites needed either. See `apps/production/zot/README.md` for the
current 5-instance/5-hostname layout, and its "Client recipes" section for
the resulting (now much simpler) kind/dind mirror config.

DNS got a wildcard record (`*.oci-registry.activescott.com`) so N upstream
subdomains don't each need their own manual DNS entry — but that's a DNS-only
concern. Certs stayed on the simple, already-proven path: each instance's
Ingress carries the standard `cert-manager.io/cluster-issuer:
letsencrypt-production` annotation and gets its own HTTP-01 cert
automatically (HTTP-01 works fine per-hostname once the wildcard DNS record
makes it resolve — no DNS-01/wildcard *cert*, no Cloudflare credential, no
new ClusterIssuer needed). A wildcard cert was considered and discarded: it
would have needed a DNS-01 solver purely to save creating N trivial
annotation-driven certs, not worth the new credential/ClusterIssuer surface
for that.

## URL layout — SUPERSEDED, see "Redesign" above

Kept for the historical record of the original (broken-for-CI) design.
Path-namespaced by upstream hostname — one `sync.registries[]` entry per
upstream, `content: [{prefix: "**", destination: "/<upstream-host>"}]`. This
is zot's own recommended shape (`examples/config-popular-registries.json`)
and works fine for direct pulls; it just isn't mirror-tool-compatible.

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

No `apps/base/` split. Everything under `apps/production/zot/`, one
`{pv,helmrelease}.yaml` pair per instance (post-redesign — see above):

- `namespace.yaml` — `Namespace: zot-oci-registry` (shared)
- `helmrepository.yaml` — `HelmRepository` `zot` →
  `https://zotregistry.dev/helm-charts` (shared, all 5 instances pin the
  same chart version)
- `zot-writable-pv.yaml` + `zot-writable-helmrelease.yaml` — the read/write
  instance (buildcache, local images), no `sync` block
- `zot-docker-pv.yaml` + `zot-docker-helmrelease.yaml` — docker.io mirror,
  the only one with a `credentialsFile` mount (Docker Hub creds)
- `zot-ghcr-pv.yaml` + `zot-ghcr-helmrelease.yaml` — ghcr.io mirror
- `zot-registryk8s-pv.yaml` + `zot-registryk8s-helmrelease.yaml` —
  registry.k8s.io mirror
- `zot-mcr-pv.yaml` + `zot-mcr-helmrelease.yaml` — mcr.microsoft.com mirror
- `kustomization.yaml` — lists all of the above, plus the `secretGenerator`
  with the exact keys `credentials.json` / `htpasswd` (renaming breaks SOPS
  format detection) — both Secrets are mounted into multiple instances via
  `externalSecrets`
- `README.md` — client-facing: instance/hostname table, accounts, client
  recipes for the ramblefeed follow-up, retention-tuning pointers

Each PV/PVC pair is hand-provisioned hostPath, `RWO`, `Retain`,
`storageClassName: ""`, under `/mnt/thedatapool/no-backup/app-data/zot-<name>/`
— same tier as `loki`'s cache: large, ephemeral, fully reproducible, not
worth backing up. Sized 20Gi (writable, docker) / 10Gi (ghcr, mcr) / 5Gi
(registryk8s) rather than one shared 50Gi PVC, since each instance is now
its own StatefulSet/chart release (the chart's `pvc.name` value is
per-release, not something 5 releases can share cleanly).

`apps/production/kustomization.yaml` gains `- ./zot` (unchanged by the
redesign — still one entry, the instance count is internal to this dir).

## Credential scripts

`scripts/create-zot-sync-credentials.sh` and `scripts/create-zot-htpasswd.sh`
mirror `scripts/create-image-pull-secret-ghcr.sh` structurally (prompt →
build → `sops -encrypt --age <pubkey>` → write into `apps/production/zot/`).
They hold no secrets themselves — only the operator's interactive input —
which is why they live here rather than in the private repo despite the
credential *identifiers* being tracked there
(`home-infra-private/inventory/registries.md`).

## DNS / cert sequencing

Post-redesign, still plain HTTP-01 via the shared `letsencrypt-production`
issuer, unchanged from the original design — the wildcard is DNS-only, no
new cert-manager credential/issuer needed. Order still matters because
HTTP-01 requires the hostname to already resolve publicly:

1. User creates the `oci-registry.activescott.com` (bare, already existed
   pre-redesign) and `*.oci-registry.activescott.com` (wildcard, new) DNS
   records, **grey-cloud / DNS-only, not proxied** (Cloudflare's proxy caps
   request body size and disallows proxying bulk binary content — a 2GB
   Playwright layer would fail through it). Confirm with
   `dig +short docker.oci-registry.activescott.com @1.1.1.1` (any subdomain
   proves the wildcard resolves).
2. Commit + push the ciphertext and manifests **together** — if manifests
   land without the secrets, the StatefulSets crash-loop on a missing
   htpasswd path.
3. Flux reconciles via webhook (do not run `flux reconcile` manually).
4. Confirm each instance's Certificate `Ready=True` — `zot-writable` reuses
   the pre-existing `oci-registry-activescott-com-tls` cert/secret (same
   hostname as before the redesign) so it needs no reissue; the 4 mirror
   instances each get a fresh HTTP-01 cert on first reconcile. If any shows
   `IncorrectCertificate`, something added a standalone `Certificate`
   resource for a secretName an Ingress annotation already owns.

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

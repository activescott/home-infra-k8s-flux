# zot — OCI registry (pull-through mirrors + buildkit cache)

Five zot instances in the `zot-oci-registry` namespace: one **writable**
instance for buildkit cache/local images, and four dedicated **mirror-only**
instances, one per upstream registry. Design rationale, research
corrections, and verified upstream-source findings are in
`docs/specs/zot-registry/plan.md`. This doc is the reference for anyone
*consuming* the registry (e.g. wiring it into ramblefeed CI) — self-contained
so that follow-up doesn't need to spelunk this repo.

## Why five instances, not one

The original design put all four upstreams behind one hostname, distinguished
by path prefix (`oci-registry.activescott.com/docker.io/...`). That doesn't
work as a drop-in target for standard container-runtime "registry mirror"
config (Docker's `daemon.json` `registry-mirrors`, containerd's
`hosts.toml`/`containerdConfigPatches`): those mechanisms preserve the
original `/v2/<repo>/...` path unprefixed and have no way to route under a
shared prefix — a request through the mirror still asks for
`/v2/library/postgres/...`, not `/v2/docker.io/library/postgres/...`, so it
never reaches the right `sync` config. zot itself doesn't support the `ns=`
query-param convention some other mirror-aware proxies use either. See
`docs/specs/zot-registry/plan.md` "Redesign" for the full trace through
containerd's docs and zot's `content.go`.

The fix: one zot instance **per upstream**, each addressed at its own
hostname, each with `sync.registries[].content[].destination: "/"` (no
prefix — confirmed via zot's `getRepoDestination`/`getRepoSource` in
`content.go`: an empty/`"/"` destination is a pure passthrough, local repo
path == upstream repo path). That makes each instance a byte-for-byte drop-in
mirror target for standard tooling. All five share one `zot-htpasswd` Secret
(same accounts everywhere) and — since this is a single-node cluster — one
approach to storage: separate small PVCs rather than one shared one, to keep
each instance's chart-managed StatefulSet simple.

## Upgrading

Every instance pins the same chart version, in the `# appVersion v...`
comment next to `version:` in each `zot-*-helmrelease.yaml`. The chart
version (`project-zot/helm-charts`) uses its own numbering, unrelated to
zot's own version — the comment is the only place that correlation is
recorded.

1. **Find the latest chart version + its correlated appVersion:**
   `https://zotregistry.dev/helm-charts/index.yaml` — entries are sorted
   newest-first; each has both `version` (chart) and `appVersion` (zot).
   Or browse releases at `https://github.com/project-zot/helm-charts/releases`.
2. **Find zot's own release notes** (what actually changed) — these are
   keyed by **appVersion**, not chart version:
   `https://github.com/project-zot/zot/releases`. Match the appVersion from
   step 1 to find the right entry.
3. **What to update:** `version:` and the `# appVersion v...` comment in
   **all five** `zot-*-helmrelease.yaml` files — keep them in lockstep,
   never bump one without the others.
4. **Before merging:** re-check this file and
   `docs/specs/zot-registry/plan.md`'s "Research corrections" section
   against the new release notes — several of zot's behaviors documented
   there (StatefulSet-selecting `persistence` combo, `externalSecrets`,
   `docker2s2` compat, retention/authz precedence, the `destination: "/"`
   passthrough behavior) were confirmed against chart `0.1.122`/appVersion
   `v2.1.18` source directly, not just docs, and could change in a later
   release.

## Instances and hostnames

| Instance | Hostname | Role | Upstream |
|---|---|---|---|
| `zot-writable` | `oci-registry.activescott.com` | read/write (`ci`) | none — local only (buildcache, built images) |
| `zot-docker` | `docker.oci-registry.activescott.com` | mirror, read-only (`mirror`) | `index.docker.io` |
| `zot-ghcr` | `ghcr.oci-registry.activescott.com` | mirror, read-only (`mirror`) | `ghcr.io` |
| `zot-registryk8s` | `registryk8s.oci-registry.activescott.com` | mirror, read-only (`mirror`) | `registry.k8s.io` |
| `zot-mcr` | `mcr.oci-registry.activescott.com` | mirror, read-only (`mirror`) | `mcr.microsoft.com` |

Each instance gets its own annotation-driven cert via the existing
`letsencrypt-production` HTTP-01 issuer (see "DNS & cert" below) — same
pattern as every other app in this cluster, no new cert-manager
infrastructure needed. A DNS *wildcard* record (`*.oci-registry.activescott.com`)
covers hostname resolution for any future upstream automatically; each
still gets its own individual cert the moment its Ingress exists.

**Caching nuance:** a *tag* pull always makes one cheap upstream manifest
round-trip to re-resolve tag→digest, even when the layers are fully cached
locally — only the (expensive) blob transfer is skipped on a cache hit. A
*digest* pull is fully offline once cached. Prefer digest pinning in CI
where round-trip latency to the WAN matters.

**Adding a fifth upstream later:** copy one of the `zot-<name>-{pv,helmrelease}.yaml`
pairs, change the hostname/upstream URL/PVC name, add it to `kustomization.yaml`.
No DNS/cert work needed (wildcard already covers it).

## Accounts

No anonymous access anywhere on the registry API (these registries are
internet-reachable by design, for cert trust — see plan.md).
`/metrics` is the one deliberate exception, see "Monitoring" below.
Passwords live in 1Password; identifiers are in
`home-infra-private/inventory/registries.md`.

| Account | Role | Used for |
|---|---|---|
| `mirror` | read-only on `**`, on the 4 mirror instances | CI runner pod pulls, kind node pulls |
| `ci` | read/write on `**`, on `zot-writable` only | buildkit `--cache-to`/`--cache-from`, pushing built images |

## Client recipes (documentation only — not implemented in this repo yet)

Because each mirror instance is a drop-in target now (no path prefix),
standard mirror config works unmodified — no image-reference rewriting
needed anywhere.

**Local desktop (Docker Desktop / Docker Engine):**
```bash
docker login docker.oci-registry.activescott.com -u mirror -p "$MIRROR_PW"
```
For docker.io specifically, Docker Desktop's registry-mirrors setting
(Settings → Docker Engine) makes this fully transparent — plain
`docker pull postgres:16` (or any unqualified/docker.io reference, including
base images in Dockerfiles built via `docker build`/skaffold) routes through
the mirror automatically once logged in:
```json
{ "registry-mirrors": ["https://docker.oci-registry.activescott.com"] }
```
For ghcr.io/registry.k8s.io/mcr.microsoft.com, Docker has no per-registry
mirror setting (mirrors are docker.io-only) — reference the mirror host
explicitly, e.g. `docker pull ghcr.oci-registry.activescott.com/owner/image:tag`
instead of `docker pull ghcr.io/owner/image:tag`.

**Outer dind daemon** (`daemon.json`, only works for docker.io — Docker's
`registry-mirrors` feature is docker.io-specific):
```json
{
  "registry-mirrors": ["https://docker.oci-registry.activescott.com"]
}
```
Combine with `docker login docker.oci-registry.activescott.com -u mirror -p "$MIRROR_PW"`
so the mirror-routed pulls are authenticated.

**kind's inner containerd** (`containerdConfigPatches` in the kind cluster
config) — one block per upstream, each a plain host-only mirror (no `ns=`
query param needed, since there's no shared-prefix ambiguity to resolve
anymore):
```toml
[plugins."io.containerd.grpc.v1.cri".registry.mirrors."registry.k8s.io"]
  endpoint = ["https://registryk8s.oci-registry.activescott.com"]
[plugins."io.containerd.grpc.v1.cri".registry.configs."registryk8s.oci-registry.activescott.com".auth]
  username = "mirror"
  password = "$MIRROR_PW"
```
(repeat per upstream: `docker.io` → `docker.oci-registry...`, `ghcr.io` →
`ghcr.oci-registry...`)

**Playwright / mcr.microsoft.com** — since `mcr.oci-registry.activescott.com`
is a real drop-in mirror now, this can go through the same outer-daemon
`registry-mirrors`-style config too, **except** Docker's `registry-mirrors`
feature is docker.io-only — for a non-docker.io outer `docker pull`
(mcr.microsoft.com), the pull still needs an explicit rewrite:
```bash
docker login mcr.oci-registry.activescott.com -u mirror -p "$MIRROR_PW"
docker pull mcr.oci-registry.activescott.com/playwright:v1.49.0-noble
```

**buildkit cache** (writable instance only):
```bash
docker login oci-registry.activescott.com -u ci -p "$CI_PW"
docker buildx build \
  --cache-to   type=registry,ref=oci-registry.activescott.com/ramblefeed/buildcache,mode=max,image-manifest=true,oci-mediatypes=true \
  --cache-from type=registry,ref=oci-registry.activescott.com/ramblefeed/buildcache \
  -t myimage:tag --load .
```

**Note for the ramblefeed follow-up:** `apps/production/github-runners/runners/ramblefeed/helmrelease.yaml`'s
dind sidecar `args:` override **replaces** the chart's default args, it
doesn't merge — adding the `daemon.json`/`registry-mirrors` config above
means re-listing the existing `--host`/`--group` flags too. See
`docs/specs/gha-runner-self-hosted/summary.md`.

## Tuning retention

Each instance's `config.json` (inline in its own `zot-*-helmrelease.yaml`)
has its own `storage.retention.policies` — no more shared multi-policy
ordering to reason about, since each instance now has exactly one policy
covering `**` (there's only one upstream/namespace per instance).

- **The 4 mirror instances**: evict any tag not pulled in `pulledWithin`
  (currently `720h` = 30 days).
- **`zot-writable`**: keeps the `mostRecentlyPushedCount` most recent pushes
  (currently 20) within `pushedWithin` (currently `2160h` = 90 days).

**To change a window:** edit that instance's policy `keepTags` object and
push — Flux picks it up on the next reconcile, no pod restart needed (zot's
retention scanner reads config on its own interval, `storage.gcInterval`,
currently 24h on every instance).

**Gotchas:**
- **Test changes with `dryRun: true` first.** Flip it, reconcile, check that
  instance's logs for what it *would* delete, then flip back to `false`.
  There's no undo once a real GC pass runs.
- `storage.gc` and `storage.gcDelay`/`gcInterval` control actual space
  reclamation separately from retention's tag-eviction decision — retention
  marks what's eligible, GC is what actually deletes it.
- Each instance has its own PVC (`zot-writable-storage-pv.yaml` = 20Gi,
  `zot-docker` = 20Gi, `zot-ghcr`/`zot-mcr` = 10Gi, `zot-registryk8s` = 5Gi)
  — if one approaches its cap despite retention, tighten that instance's
  window rather than resizing the PV first (these are meant to stay bounded
  caches).

## DNS & cert

- **Public DNS**: `oci-registry.activescott.com` (bare, for `zot-writable`)
  plus a wildcard `*.oci-registry.activescott.com` (covers all mirror
  instances, and any added later) — both CNAME to `k8s.activescott.com`,
  **grey-cloud / DNS-only, not Cloudflare-proxied** (the proxy caps request
  body size and disallows proxying bulk binary content; large layer
  pushes/pulls, e.g. the Playwright image at ~2GB, would fail through it).
- **LAN DNS**: same two records as OPNsense/Unbound host overrides →
  `10.1.111.20` (the node IP), so LAN/in-cluster clients resolve directly
  instead of hairpinning out through the WAN and back for every pull. Public
  resolution still goes through Cloudflare to the real WAN IP for anything
  off-LAN. Cert stays valid either way (TLS is hostname/SNI-based, not tied
  to the resolved IP).
- **Cert**: annotation-driven, same pattern as every other app in this
  cluster — each of the 5 Ingress resources carries
  `cert-manager.io/cluster-issuer: letsencrypt-production`, and ingress-shim
  auto-creates that instance's own `Certificate` via HTTP-01 the moment the
  Ingress exists. `zot-writable` reuses the exact hostname + secretName
  (`oci-registry-activescott-com-tls`) from before this redesign, so its
  cert was already valid and needed no reissue. The 4 mirror instances each
  get a fresh cert on first reconcile, secretName
  `<subdomain>-oci-registry-activescott-com-tls`. No standalone `Certificate`
  resource anywhere in this dir — adding one for a secretName an Ingress
  annotation already owns would create a second Certificate fighting over
  the same secret (see `docs/specs/cert-management-standardization/plan.md`).
  No DNS-01/Cloudflare credential needed: the wildcard DNS record is enough
  for HTTP-01 to resolve any of these hostnames.

## Monitoring

Grafana dashboard: **zot OCI Registry**
(`apps/production/monitoring/grafana/dashboards/zot-oci-registry.json`) —
originally built for the single-instance design; the "Registry Up" panel
was updated to count across all 5 StatefulSet pods
(`pod=~"zot-.*-0"`), but per-repo panels don't yet distinguish which
instance a repo's metrics came from (low collision risk in practice since
each instance mirrors a distinct, differently-named upstream, but a
faithful per-instance breakdown is a documented follow-up, not done here).

Scraped via this cluster's default Prometheus pod-annotation convention
(`podAnnotations` in each `zot-*-helmrelease.yaml` — see
`apps/production/monitoring/README.md` "Adding a scrape target"), same port
as each instance's registry API (5000), path `/metrics`.

**`/metrics` is anonymous-readable on every instance**, unlike every other
path. Each instance's metrics endpoint has its own access-control block
separate from its registry API's, and Prometheus's default scrape job can't
inject per-target credentials — see the comment above
`configFiles."config.json"` in any `zot-*-helmrelease.yaml` for the full
tradeoff. Only usage counts/gauges are exposed (no image content, no
credentials), and it's the same posture every other scraped app in this
cluster has, but it does mean e.g.
`https://docker.oci-registry.activescott.com/metrics` is publicly reachable
too, since each Ingress forwards all paths to its backend.

## Verification (maps to the three acceptance criteria in the issue)

**Mirror + cache (AC-1):**
```bash
docker login docker.oci-registry.activescott.com -u mirror -p "$MIRROR_PW"
time docker pull docker.oci-registry.activescott.com/library/postgres:16   # cold
docker rmi docker.oci-registry.activescott.com/library/postgres:16
time docker pull docker.oci-registry.activescott.com/library/postgres:16   # warm - should be much faster
```

**buildkit cache round-trip (AC-2):**
```bash
docker login oci-registry.activescott.com -u ci -p "$CI_PW"
docker buildx build \
  --cache-to   type=registry,ref=oci-registry.activescott.com/ramblefeed/buildcache,mode=max,image-manifest=true,oci-mediatypes=true \
  --cache-from type=registry,ref=oci-registry.activescott.com/ramblefeed/buildcache \
  -t throwaway:test --load .
curl -su ci:$CI_PW https://oci-registry.activescott.com/v2/ramblefeed/buildcache/tags/list
```

**Authenticated Hub pulls, no anonymous exposure (AC-3):**
```bash
curl -sI https://docker.oci-registry.activescott.com/v2/   # expect 401 - anonymous denied everywhere
```
Compare Docker Hub's `ratelimit-limit` header authenticated vs anonymous to
confirm the sync credential is actually earning the higher quota (see
`docs/specs/zot-registry/plan.md` for the full curl incantation).

zot's image has no shell (`kubectl exec` won't work) — logs, the Secret,
and HTTP are the only verification channels.

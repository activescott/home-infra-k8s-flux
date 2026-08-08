# zot — OCI registry (pull-through mirror + buildkit cache)

`oci-registry.activescott.com`. Design rationale, research corrections, and
verified upstream-source findings are in
`docs/specs/zot-registry/plan.md`. This doc is the reference for anyone
*consuming* the registry (e.g. wiring it into ramblefeed CI) — self-contained
so that follow-up doesn't need to spelunk this repo.

## Upgrading

`helmrelease.yaml`'s `spec.chart.spec.version` is the **chart** version
(`project-zot/helm-charts`), which uses its own numbering — it is not the
same as zot's own version. The two are correlated via the chart's
`appVersion` field, which is why the pinned line carries a trailing
`# appVersion v...` comment — keep that comment in sync whenever you bump
the version, it's the only place the correlation is recorded here.

1. **Find the latest chart version + its correlated appVersion:**
   `https://zotregistry.dev/helm-charts/index.yaml` — entries are sorted
   newest-first; each has both `version` (chart) and `appVersion` (zot).
   Or browse releases at `https://github.com/project-zot/helm-charts/releases`.
2. **Find zot's own release notes** (what actually changed) — these are
   keyed by **appVersion**, not chart version:
   `https://github.com/project-zot/zot/releases`. Match the appVersion from
   step 1 to find the right entry.
3. **What to update:** both `version:` and the `# appVersion v...` comment
   on the same line in `helmrelease.yaml` — never bump one without the
   other, or the comment becomes misleading.
4. **Before merging:** re-check this file's "Operational notes" and
   `docs/specs/zot-registry/plan.md`'s "Research corrections" section
   against the new release notes — several of zot's behaviors documented
   there (StatefulSet-selecting `persistence` combo, `externalSecrets`,
   `docker2s2` compat, retention/authz precedence) were confirmed against
   chart `0.1.122`/appVersion `v2.1.18` source directly, not just docs, and
   could change in a later release.

## URL layout

Path-namespaced by upstream hostname. The following four top-level path
segments are **reserved for sync** — anything else is an ordinary local
read/write repo (e.g. `ramblefeed/buildcache`), no collision by construction:

| Client pulls | zot fetches from |
|---|---|
| `oci-registry.activescott.com/docker.io/library/postgres:16` | `index.docker.io/library/postgres:16` |
| `oci-registry.activescott.com/ghcr.io/actions/actions-runner:2.336.0` | `ghcr.io/actions/actions-runner:2.336.0` |
| `oci-registry.activescott.com/registry.k8s.io/ingress-nginx/controller:v1.11.2` | `registry.k8s.io/ingress-nginx/controller:v1.11.2` |
| `oci-registry.activescott.com/mcr.microsoft.com/playwright:v1.49.0-jammy` | `mcr.microsoft.com/playwright:v1.49.0-jammy` |

**Caching nuance:** a *tag* pull always makes one cheap upstream manifest
round-trip to re-resolve tag→digest, even when the layers are fully cached
locally — only the (expensive) blob transfer is skipped on a cache hit. A
*digest* pull is fully offline once cached. Prefer digest pinning in CI
where round-trip latency to the WAN matters.

## Accounts

No anonymous access anywhere (this registry is internet-reachable by
design, for cert trust — see plan.md). Passwords live in 1Password;
identifiers are in `home-infra-private/inventory/registries.md`.

| Account | Role | Used for |
|---|---|---|
| `mirror` | read-only on `**` | CI runner pod pulls, kind node pulls |
| `ci` | read/write on `**` | buildkit `--cache-to`/`--cache-from`, pushing built images |

## Client recipes (documentation only — not implemented in this repo yet)

**dind / docker login:**
```bash
docker login oci-registry.activescott.com -u mirror -p "$MIRROR_PW"
docker pull oci-registry.activescott.com/docker.io/library/postgres:16
```

**kind `containerdConfigPatches`** — register both the mirror routing and
auth for the reserved prefixes your kind cluster needs, e.g.:
```toml
[plugins."io.containerd.grpc.v1.cri".registry.configs."oci-registry.activescott.com".auth]
  username = "mirror"
  password = "$MIRROR_PW"
```

**buildkit cache:**
```bash
docker login oci-registry.activescott.com -u ci -p "$CI_PW"
docker buildx build \
  --cache-to   type=registry,ref=oci-registry.activescott.com/ramblefeed/buildcache,mode=max,image-manifest=true,oci-mediatypes=true \
  --cache-from type=registry,ref=oci-registry.activescott.com/ramblefeed/buildcache \
  -t myimage:tag --load .
```

**Note for the ramblefeed follow-up:** `apps/production/github-runners/runners/ramblefeed/helmrelease.yaml`'s
dind sidecar `args:` override **replaces** the chart's default args, it
doesn't merge — if that work ever needs to add dockerd flags (e.g. for a
registry mirror), the existing `--host`/`--group` flags must be re-listed
too. See `docs/specs/gha-runner-self-hosted/summary.md`.

## Tuning retention

Retention is configured in `helmrelease.yaml`'s inline `config.json`, under
`storage.retention.policies`. Two policies exist today:

1. **Mirror repos** (`docker.io/**`, `ghcr.io/**`, `registry.k8s.io/**`,
   `mcr.microsoft.com/**`) — evicts any tag not pulled in the last
   `pulledWithin` window (currently `720h` = 30 days).
2. **Everything else** (`**`, i.e. local/writable repos like
   `ramblefeed/buildcache`) — keeps the `mostRecentlyPushedCount` most
   recent pushes (currently 20) within `pushedWithin` (currently `2160h` =
   90 days).

**To change either window:** edit the relevant policy's `keepTags` object
and push — Flux picks it up on the next reconcile, no pod restart needed
(zot's retention scanner reads config on its own interval, `storage.gcInterval`,
currently 24h).

**Gotchas:**
- **Policy order matters and is the opposite of access-control precedence.**
  Retention is *first-match-wins* (access control is longest-glob-wins), so
  the mirror-repos policy must stay listed **before** the `**` catch-all —
  reversing the order silently makes the catch-all win for everything.
- **Test changes with `dryRun: true` first.** Flip it, reconcile, check zot's
  logs for what it *would* delete, then flip back to `false`. There's no undo
  once a real GC pass runs.
- `storage.gc` and `storage.gcDelay`/`gcInterval` control actual space
  reclamation separately from retention's tag-eviction decision — retention
  marks what's eligible, GC is what actually deletes it.
- Overall PVC is 50Gi (`zot-pv.yaml`) — if usage approaches that despite
  retention, tighten the windows above rather than resizing the PV first
  (this is meant to stay a bounded cache).

## Verification (maps to the three acceptance criteria in the issue)

**Mirror + cache (AC-1):**
```bash
docker login oci-registry.activescott.com -u mirror -p "$MIRROR_PW"
time docker pull oci-registry.activescott.com/docker.io/library/postgres:16   # cold
docker rmi oci-registry.activescott.com/docker.io/library/postgres:16
time docker pull oci-registry.activescott.com/docker.io/library/postgres:16   # warm - should be much faster
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
curl -sI https://oci-registry.activescott.com/v2/   # expect 401 - anonymous denied everywhere
```
Compare Docker Hub's `ratelimit-limit` header authenticated vs anonymous to
confirm the sync credential is actually earning the higher quota (see
`docs/specs/zot-registry/plan.md` for the full curl incantation).

zot's image has no shell (`kubectl exec` won't work) — logs, the Secret,
and HTTP are the only verification channels.

## Operational notes

- **DNS must be grey-cloud (DNS-only), not Cloudflare-proxied.** The proxy
  caps request body size and disallows proxying bulk binary content — large
  layer pushes/pulls (the Playwright image is ~2GB) will fail through it.
- **LAN DNS override is in place** (OPNsense/Unbound host override:
  `oci-registry.activescott.com` → `10.1.111.20`, the node IP). LAN/in-cluster
  clients resolve directly instead of hairpinning out through the WAN and
  back for every pull — meaningful given the size of some mirrored images.
  Public resolution still goes through Cloudflare (grey-cloud) to the real
  WAN IP for anything off-LAN. Cert stays valid either way (TLS is
  hostname/SNI-based, not tied to the resolved IP).
- Storage: hostPath PV under `/mnt/thedatapool/no-backup/app-data/zot`,
  intentionally not backed up — this is a bounded, fully-reproducible cache.

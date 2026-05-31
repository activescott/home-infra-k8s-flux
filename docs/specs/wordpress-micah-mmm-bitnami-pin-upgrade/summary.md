# wordpress-micah-mmm: Bitnami image pin + upgrade — summary

> **⚠️ Digest-pinning against Bitnami's free tier is not a durable
> strategy.** The pin we landed in `f82ab7a` and `ec350b5` works
> *for now* because containerd has the layers cached locally on the
> `nas` node, but the pinned digests are subject to silent removal
> from the public registry whenever Bitnami rebuilds `:latest`. One
> node rebuild, one image-GC pass, or one Bitnami refresh and the
> pinned pods will go `ImagePullBackOff`.
>
> **Empirical proof from this work**: the digest the
> wordpress-micah-mmm cluster was *already running* on 2026-02-24
> (`bitnami/wordpress@sha256:a767c9fc...`) already 404s from the
> public registry as of 2026-05-31. We pinned to it anyway because
> the running pod's layers were cached; that cache is the only
> thing keeping the site reschedulable on its own digest today.
>
> See the **Key discovery** section below for full evidence and
> references. The repo-level README also has a top-level warning.
> Migrate off `bitnami/*` runtime images per **Option D** when you
> can.

## TL;DR for the user

- **Step 1 (pin) — done and verified.** Both wordpress and mariadb
  image refs in the cluster are now pinned by digest. Site is up,
  zero behavior change. Commit `f82ab7a`.
- **Step 2 (image upgrade) — done for mariadb only.** MariaDB
  bumped to current `:latest` amd64 sub-digest, which is still
  MariaDB 12.2.2 — just a fresh Photon OS 5 base layer. Commit
  `ec350b5`.
- **WordPress image upgrade deferred for your daytime review.**
  Bitnami's current `:latest` is **WordPress 7.0.0**, released the
  same day this work happened (2026-05-30). A major-version bump on
  a same-day release, on a chart pinned to a 6.x-era version, on
  your son's business site, with no DB backup, is not something I
  was willing to do unsupervised. See the **WordPress 7.0.0
  decision section** below.

## What changed

### `f82ab7a` — pin both images by digest to currently-running

Added `image.digest` and `mariadb.image.digest` to
`apps/production/wordpress-micah-mmm/patch-helmrelease.yaml`:

| Component | Digest pinned | Resolved version |
|---|---|---|
| wordpress | `sha256:a767c9fcab3eb2c140c791fb0095b575cb9696ea1732972bc8e0b522194f68a1` | WordPress 6.9.1 on Photon OS 5 |
| mariadb | `sha256:3092b0b72758aedadea2f16ad352388f0067ec68a6a58672a6a7ae61d4278e81` | MariaDB 12.2.2 |

Result in cluster:
```
$ kubectl get deploy wordpress -o jsonpath='{.spec.template.spec.containers[0].image}'
registry-1.docker.io/bitnami/wordpress@sha256:a767c9fc...

$ kubectl get sts wordpress-mariadb -o jsonpath='{.spec.template.spec.containers[0].image}'
registry-1.docker.io/bitnami/mariadb@sha256:3092b0b7...
```

Pull policy is now `IfNotPresent` on both (default for digest refs).

Note: `kubectl get pod ... -o jsonpath='{.status.containerStatuses[].image}'`
still shows `:latest` because that's the kubelet's local-cache
index for the layers — but the pod-spec, which is what kubelet
actually uses to pull, references the digest. Verified by reading
`.spec.template.spec.containers[].image` on both controllers.

Smoke tests after rollout:
- HEAD `https://mmm.willeke.com/` → 200
- GET `https://mmm.willeke.com/` → title "Micah's Meticulous Mowing"
- `https://mmm.willeke.com/wp-admin/` → redirects to wp-login.php
- `https://mmm.willeke.com/wp-json/wp/v2/posts` → 200, returns posts

### `ec350b5` — bump mariadb digest to current `:latest` (still 12.2.2)

Changed `mariadb.image.digest` to
`sha256:be1cefc3af0bbfc5d359dc1fde74f0d573a1ec6cb8ec7b50375708bfcf1d8eee`.

Resolved version: MariaDB 12.2.2 — same as before, just a 2026-05-30
rebuild on a fresher Photon OS 5 base layer. No DB engine upgrade,
no schema migration. The motivation is that the old digest is no
longer in the public registry (see below); bumping to current
`:latest`'s amd64 sub-digest restores our ability to reschedule
the pod without depending on the node's local image cache.

## Key discovery: Bitnami secure-images is real and active

This is the most important finding for future work in this repo:

> Both digests that were running in cluster as of 2026-05-30
> **return 404 from the public registry today**:
>
>   `https://registry-1.docker.io/v2/bitnami/wordpress/manifests/sha256:a767c9fc...` → 404
>   `https://registry-1.docker.io/v2/bitnami/mariadb/manifests/sha256:3092b0b7...` → 404
>
> Listing tags on `bitnami/wordpress` returns only `latest` and
> `latest-metadata` (plus `sha256-...` signature/attestation
> metadata tags). No `6.x`, no `7.x`, no `12.2.2` — none of the
> human-friendly version tags survive in the free tier.

This confirms Bitnami's Aug-2025 secure-images distribution change
in production. **Implication for this cluster:** any of our Bitnami
workloads still tagged `:latest` is one image-GC event away from
unrecoverable. The cluster's running pod survives only because
containerd has the bytes cached locally on the nas node.

### Authoritative references on the Bitnami change

- **Canonical announcement (GitHub issue):**
  <https://github.com/bitnami/containers/issues/83267> —
  "Upcoming changes to the Bitnami catalog (effective August 28th,
  2025)". Public-catalog deletion was postponed from Aug 28 to
  Sep 29, 2025 after community pushback.
- **Broadcom press release (Jul 17, 2025):**
  <https://news.broadcom.com/app-dev/broadcom-introduces-bitnami-secure-images-for-production-ready-containerized-applications>
- **Legacy archive (frozen, unpatched, temporary mirror):**
  <https://hub.docker.com/u/bitnamilegacy>
- **Hardened paid catalog (Bitnami Secure Images / BSI):**
  <https://hub.docker.com/u/bitnamisecure>
- **Original (now-restricted) free namespace:**
  <https://hub.docker.com/u/bitnami> — kept, but only a focused
  set of hardened images tagged `:latest`. Non-`:latest` historical
  tags moved to `bitnamilegacy` and stopped receiving patches.
- **Subscribe to BSI:** <https://go-vmware.broadcom.com/contact-us>

Workloads currently using bitnami images in this repo:
- `wordpress-micah-mmm` (just pinned)
- *(no others as of this commit; verify with `grep -r bitnami apps/`)*

## WordPress 7.0.0 decision section

After step 1 and step 2-mariadb landed, the only remaining piece of
the original ask is "bump wordpress to a more recent release."
Bitnami's `:latest` resolved to:

| Field | Value |
|---|---|
| amd64 sub-digest | `sha256:2ba502da22c0474abc31134ca739059fc58b6411b1aaba70b4038855324ffa01` |
| `org.opencontainers.image.version` | `7.0.0` |
| `org.opencontainers.image.created` | `2026-05-30T13:12:53Z` |

That is WordPress **7.0.0**, released the same day as this work.

### Why I deferred this and didn't push it tonight

1. **Major-version bump.** 6.9.1 → 7.0.0 is a major release.
   WordPress historically uses semver loosely, but a 7.0.0 cut
   strongly implies breaking changes (theme/plugin API, REST API,
   WP-CLI, possibly DB schema).

2. **Released the same day.** Day-of-release on a production site
   means no community has yet hit and reported the surprise
   regressions. Bitnami's image was built on 2026-05-30; we
   would have been very-early adopters.

3. **Chart pinned at 29.1.1 pre-dates WP 7.x.** The bundled
   `bitnami/wordpress` chart 29.1.1 was published when WP 6.x was
   current. Its `appVersion` and init logic are written against
   6.x. Mixing chart 29.x with image 7.x is officially
   unsupported.

4. **No DB backup.** Same lesson photoprism's MariaDB upgrade
   taught us yesterday (see
   `docs/specs/photoprism-mariadb-10.11-upgrade/summary.md`):
   "is the version jump safe" is independent of "is the existing
   data safe." A WP 7.0.0 first-start would run the WP
   `/wp-admin/upgrade.php` schema migration on the live DB; if
   that fails partway, there's no clean recovery without a
   restore. We have no `mysqldump` snapshot of
   `wordpress-micah-mmm-mariadb-pvc`.

5. **Your son uses this site for his business.** Your standing
   instruction for tonight was "Just make sure we don't screw it
   up." A major-version + same-day-release + chart mismatch + no
   backup combination is exactly the shape that screws things up
   silently — the pod might come up green, but
   themes/plugins/admin/REST API can break in ways that don't
   show on `curl -I`.

### Options when you come back to this

**Option A — Bump chart first, then image.** Find the latest
bitnami/wordpress chart that officially targets WP 7.x (check
`https://app-catalog.vmware.com/bitnami/releases/a38d840c-0692-4786-87ec-e4eac1128259`,
that link is in our HelmRelease comment). Bump chart version,
clear the digest pin, let chart defaults select its matching WP
7.x image. This is the path Bitnami itself supports.

**Option B — Stay on 6.x semi-permanently.** Because Bitnami no
longer publishes 6.x tags publicly, the only way to *stay* on 6.x
with security updates is to either:
- mirror the image into your own registry (e.g., ghcr.io or
  a self-hosted registry running on the nas) — pay-once-for-LTS
  effectively, OR
- migrate off `bitnami/wordpress` to a different upstream (e.g.,
  the official `wordpress` image on Docker Hub or an
  community-maintained Helm chart), which is a larger lift but
  removes the Bitnami-policy dependency entirely.

**Option C — Just bump to 7.0.0 with a backup taken first.** Take
a `mysqldump` of `wordpress` DB, snapshot the
`wordpress-micah-mmm-wp-pvc` directory, then do the same kind of
digest swap as `ec350b5` but for wordpress instead of mariadb.
Roll, smoke-test, and if anything is wrong, revert the commit
(the 6.9.1 digest is still cached on the node so the rollback
pod will start instantly). DB rollback would be from the
`mysqldump`.

My recommendation: **Option A or C, after backups.** Option A is
cleaner long-term but more change at once; Option C is the
smallest possible WP-version-bump step and the right shape for
this repo if you want to learn what 7.0.0 does to the site
without committing to a chart upgrade.

## Resume commands

```bash
# verify pin in cluster
kubectl --context nas -n wordpress-micah-mmm get deploy wordpress \
  -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl --context nas -n wordpress-micah-mmm get sts wordpress-mariadb \
  -o jsonpath='{.spec.template.spec.containers[0].image}'; echo

# smoke test the site
curl -sSI https://mmm.willeke.com/ | head -3
curl -sS https://mmm.willeke.com/wp-json/wp/v2/posts | jq 'length, .[0].title'

# take a backup before any WP version bump
kubectl --context nas -n wordpress-micah-mmm exec wordpress-mariadb-0 -- \
  bash -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --all-databases' \
  > /tmp/wordpress-micah-mmm-pre-wp7-backup.sql

# resolve current :latest amd64 sub-digest for either image
token=$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:bitnami/wordpress:pull" | jq -r .token)
curl -fsSL -H "Authorization: Bearer ${token}" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/bitnami/wordpress/manifests/latest" \
  | jq -r '.manifests[]? | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest'

# inspect the labels/version of an image by digest
# (replace REPO and DIGEST below)
token=$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:bitnami/wordpress:pull" | jq -r .token)
manifest=$(curl -fsSL -H "Authorization: Bearer ${token}" \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
  "https://registry-1.docker.io/v2/bitnami/wordpress/manifests/sha256:...")
config_digest=$(echo "$manifest" | jq -r '.config.digest')
curl -fsSL -H "Authorization: Bearer ${token}" \
  "https://registry-1.docker.io/v2/bitnami/wordpress/blobs/${config_digest}" \
  | jq '.config.Labels'
```

## State at end of session

- Branch: `main` at `ec350b5`.
- Pods (confirmed by step-2 watcher at 2026-05-31 08:22 PDT):
  - `wordpress-5584fcdd4f-frl9b` 1/1 Running, 0 restarts,
    image @ `sha256:a767c9fc...` (WordPress 6.9.1 — unchanged).
  - `wordpress-mariadb-0` 1/1 Running, 0 restarts, age ~50s,
    image @ `sha256:be1cefc3...` (MariaDB 12.2.2 fresh Photon-OS-5
    base).
- HelmRelease `wordpress.v4`, `UpgradeSucceeded`.
- Site: `https://mmm.willeke.com/` returning 200.

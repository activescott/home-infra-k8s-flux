# wordpress-micah-mmm: migrate off Bitnami to upstream images

## Goal

Eliminate the `wordpress-micah-mmm` workload's dependency on the
`bitnami/*` runtime images and the `bitnamicharts/wordpress` Helm
chart. Replace with hand-written kustomize manifests pulling from
the upstream `library/wordpress` and `library/mariadb` images on
Docker Hub, which have stable named version tags maintained by the
Docker official-images team plus WordPress and MariaDB upstream.

Repo convention is "plain kubectl yaml + Kustomize" (see top-level
README), so the chart abstraction is a net loss here.

## Why now

`docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/summary.md`
documents that the pin we just landed is *not durable*. Bitnami's
free tier rotates non-`:latest` digests out within weeks-to-months,
and the digest the cluster was running on 2026-02-24 already 404s
from the public registry as of 2026-05-31. The pinned pod survives
only as long as containerd has the layers cached on the `nas` node;
one node rebuild, image GC pass, or `crictl rmi` and the site goes
to ImagePullBackOff. Migrating now gets us off that clock.

## Non-goals

- Upgrading WordPress beyond 6.9.1 in this migration. The goal is
  *vendor* swap, not *version* bump. Same WP version, same MariaDB
  version, same data — different images and chart. Version bumps
  come after the vendor swap is stable.
- Changing the storage class, network model, ingress controller,
  TLS issuer, hostname, or anything else the chart doesn't own.
- Migrating away from hostPath PVs. The cluster runs single-node,
  hostPath is the existing pattern.

## Strategy: side-by-side with full data copy

Build the new stack in a **separate namespace** (`wordpress-micah-mmm-v2`)
with its own **fresh hostPath dirs** and its own **copied data**.
The old stack stays running on the live data the entire time. Only
at the cutover step (Phase 5) do we swap the Ingress, and even
then the old data and old namespace remain untouched as a safety
net for at least 48-72 hours.

This gives true rollback: if v2 has any post-cutover issue we
swap Ingress back, scale old back up, and the old data is exactly
where we left it.

### Data flow

```
                    ┌─────────────────────────────────────┐
   live old data    │  /mnt/thedatapool/app-data/         │
   (untouched)      │   wordpress-micah-mmm/              │
                    │     mariadb/   ← live MariaDB datadir│
                    │     wordpress/ ← live /opt/bitnami/  │
                    │                  wordpress/ tree    │
                    └──────────────────┬──────────────────┘
                                       │ Phase 2:
                                       │  - mysqldump --all-databases
                                       │  - rsync wp-content/ subdir only
                                       ▼
                    ┌─────────────────────────────────────┐
   fresh v2 data    │  /mnt/thedatapool/app-data/         │
   (built by us)    │   wordpress-micah-mmm-v2/           │
                    │     mariadb/      ← fresh datadir   │
                    │     wp-content/   ← rsynced copy    │
                    │     restore.sql   ← mysqldump output│
                    └─────────────────────────────────────┘
```

The v2 MariaDB StatefulSet's init step restores `restore.sql` into
a fresh datadir. The v2 WordPress Deployment mounts `wp-content/`
as a subdir under `/var/www/html/`, letting the official image
bootstrap a clean WP core into the rest of `/var/www/html/`.

## Image and version choices

| Component | Old | New | Rationale |
|---|---|---|---|
| WordPress | `bitnami/wordpress@sha256:a767c9fc…` (6.9.1, Photon 5) | `wordpress:6.9.1-php8.3-apache` | Exact same WP version. Apache + mod_php matches the Bitnami stack. PHP 8.3 matches Bitnami's PHP. Stable named tag from Docker official-images. |
| MariaDB | `bitnami/mariadb@sha256:be1cefc3…` (12.2.2, Photon 5) | `mariadb:12.2.2-noble` | Exact same MariaDB version. `noble` is the Ubuntu 24.04 base — modern, official, stable. On-disk format is identical to Bitnami's MariaDB 12.2.2 build. |
| Chart | `bitnamicharts/wordpress:29.1.1` | — none — | Replaced by hand-written kustomize overlay. |

We will *not* pin by digest. Named version tags from `library/*`
are stable artifacts on Docker Hub — that's the whole point of
upstream official images. We get human-readable diffs on future
bumps without the secure-images time-bomb.

## Path mappings

### WordPress container

| | Bitnami | Official `library/wordpress` |
|---|---|---|
| Install root | `/opt/bitnami/wordpress/` | `/var/www/html/` |
| `wp-content/` | `/opt/bitnami/wordpress/wp-content/` | `/var/www/html/wp-content/` |
| `wp-config.php` | `/opt/bitnami/wordpress/wp-config.php` | `/var/www/html/wp-config.php` |
| Web server | Apache from `/opt/bitnami/apache/` | Apache from Debian base |
| Doc root | `/opt/bitnami/wordpress/` | `/var/www/html/` |

**What to copy:** only the `wp-content/` subdirectory. That's
where themes, plugins, uploads, mu-plugins, and any
customizations live. The WP core PHP files are vendored *with*
the image; copying them across vendors invites version-skew bugs.

**`wp-config.php`:** the official `wordpress` image generates one
from env vars on first start. We pass the **same salts** as the
old install (extracted from the running Bitnami pod's
`wp-config.php`) so logged-in sessions survive the migration:

```
WORDPRESS_AUTH_KEY
WORDPRESS_SECURE_AUTH_KEY
WORDPRESS_LOGGED_IN_KEY
WORDPRESS_NONCE_KEY
WORDPRESS_AUTH_SALT
WORDPRESS_SECURE_AUTH_SALT
WORDPRESS_LOGGED_IN_SALT
WORDPRESS_NONCE_SALT
```

Plus the standard DB env vars:
```
WORDPRESS_DB_HOST=mariadb
WORDPRESS_DB_USER=<existing user>
WORDPRESS_DB_PASSWORD=<existing password>
WORDPRESS_DB_NAME=<existing DB name>
WORDPRESS_TABLE_PREFIX=wp_       # WP default; Bitnami's default too
```

DB credentials must match exactly what the existing schema's
grants permit. We reuse the existing values from
`apps/production/wordpress-micah-mmm/.env.secret.wordpress-creds.encrypted`.

### MariaDB container

| | Bitnami | Official `library/mariadb` |
|---|---|---|
| Datadir | `/bitnami/mariadb/data` | `/var/lib/mysql` |
| Init scripts dir | `/docker-entrypoint-initdb.d/` | `/docker-entrypoint-initdb.d/` (same — official convention) |
| Conf | `/opt/bitnami/mariadb/conf/my.cnf` | `/etc/mysql/my.cnf` |

For v2 we start with a **fresh empty datadir** and rely on the
official entrypoint to run `mariadb-install-db` on first start,
then execute everything in `/docker-entrypoint-initdb.d/` to
restore our dump. The dump (`restore.sql` from
`mysqldump --all-databases`) brings the `mysql.*` system DB,
which carries user accounts and grants exactly as they were on
the Bitnami side. No grant rebuild needed.

The first-start envs the official image requires:

```
MARIADB_ROOT_PASSWORD=<from old creds — see note below>
```

**Why same root password?** Because the dumped `mysql.global_priv`
includes the existing root account hash. If we initialize with a
*different* root password the init scripts will set one root
password, then the dump restore overwrites it with the old. We
end up at the old password either way — but using the same one
avoids a brief moment of init-vs-restore mismatch and matches the
existing operational model.

## Manifest layout for v2

```
apps/production/wordpress-micah-mmm-v2/
├── kustomization.yaml
├── namespace.yaml
├── pv-mariadb.yaml             ← hostPath /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb
├── pv-wp-content.yaml          ← hostPath /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content
├── pvc-mariadb.yaml
├── pvc-wp-content.yaml
├── .env.secret.wordpress-creds.encrypted
│       # WORDPRESS_DB_USER, WORDPRESS_DB_PASSWORD, WORDPRESS_DB_NAME,
│       # MARIADB_ROOT_PASSWORD, the 8 WORDPRESS_*_KEY/SALT values.
├── configmap-mariadb-initdb.yaml
│       # binaryData restore.sql.gz — the mysqldump output.
│       # Mounted at /docker-entrypoint-initdb.d/restore.sql.gz
├── statefulset-mariadb.yaml
├── service-mariadb.yaml
├── deployment-wordpress.yaml
├── service-wordpress.yaml
└── ingress-wordpress.yaml      ← NOT applied until cutover (Phase 5)
```

The Ingress object is **kept out of the kustomization** until
Phase 5. Until then v2 is reachable only via port-forward, and
the live `mmm.willeke.com` traffic hits the old namespace's
Ingress.

### Why ConfigMap for the SQL dump instead of an init container?

Two options were considered:

1. **ConfigMap with binaryData**: gzipped SQL dump baked into the
   manifest, mounted at `/docker-entrypoint-initdb.d/`. Self-contained
   in the kustomize overlay. Limit: ConfigMap can be up to 1 MiB.
2. **Init container that copies from a backup hostPath**: more
   flexible for larger dumps, but adds a moving part.

For mmm.willeke.com the DB dump is expected to be small (single
WP install, one post). If it exceeds the ConfigMap limit, fall
back to option 2 (init container reading from
`/mnt/thedatapool/backups/wordpress-micah-mmm/<timestamp>.sql`).
Determined empirically in Phase 1.

## Cutover model

At Phase 5 the Ingress swap looks like:

1. Take a final fresh mysqldump from old → restore into v2 (catches
   any writes between the bulk copy and now).
2. Rsync any wp-content delta from old to v2.
3. Scale old `wordpress` deployment to 0 (stops writes; old MariaDB
   stays up briefly for one more verification dump if needed).
4. Apply the v2 Ingress object — it claims `mmm.willeke.com`. Old
   Ingress still exists momentarily but its backend service has no
   pods, so it would return 5xx anyway.
5. Delete old Ingress.
6. cert-manager: the new Ingress will trigger a new Certificate in
   the v2 namespace. To avoid Let's Encrypt rate-limit risk during
   cutover, **copy the existing TLS secret to v2 namespace** before
   the Ingress swap so the new Ingress finds an existing valid cert
   immediately:
   ```
   kubectl --context nas -n wordpress-micah-mmm get secret mmm-willeke-com-tls -o yaml \
     | sed 's/namespace: wordpress-micah-mmm/namespace: wordpress-micah-mmm-v2/' \
     | kubectl --context nas apply -f -
   ```
   The v2 Ingress's `cert-manager.io/cluster-issuer` annotation will
   eventually re-issue under v2's own Certificate object, but the
   pre-staged secret avoids the issuance gap.
7. Verify `https://mmm.willeke.com/` returns 200 from the v2 pod.

### Rollback at any point during cutover

- Re-apply the old Ingress manifest.
- Scale old `wordpress` deployment back to >= 1.
- Old data is untouched and consistent.

## Phases

### Phase 1 — Backup (safe, autonomous, no cluster mutation)

- `mysqldump --all-databases` from the running Bitnami mariadb pod
  to a local file `backup-<timestamp>.sql`.
- `tar` of `/opt/bitnami/wordpress/wp-content/` from the running
  wordpress pod to a local file `wp-content-<timestamp>.tar.gz`.
- Extract the 8 salt constants from the running pod's
  `wp-config.php` into a local file `salts-<timestamp>.txt`.
- Print sizes and `sha256sum`s of each.
- Store under `/tmp/wpmicah-migration/` for use in Phase 2 and 3.
  **These files are also the user-facing backup**: copy them off the
  workstation before Phase 5 if you want belt-and-suspenders.

Success criteria: three non-empty files; SQL dump contains
`CREATE TABLE` for `wp_options`; tarball contains `themes/`,
`plugins/`, `uploads/` subdirs.

### Phase 2 — Stage v2 data on nas (safe, autonomous)

- Create `/mnt/thedatapool/app-data/wordpress-micah-mmm-v2/{mariadb,wp-content}/`
  with the correct ownership (uid 999:999 is the official
  mariadb image's runtime UID; uid 33:33 — `www-data` — for WP).
- `rsync` the contents of `wp-content-<timestamp>.tar.gz` into
  `/mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/`.
- The MariaDB datadir stays empty — official image will init it
  on first pod start.

Done via a one-shot Job that mounts the hostPath and unpacks the
tarball server-side. Saves us from local-to-nas data transfer.

### Phase 3 — Write v2 manifests (safe, autonomous)

Build the kustomize overlay per the layout above. Encrypt the
secret with sops. Wire into `apps/production/kustomization.yaml`.

Critical detail: **do NOT include the Ingress in the
kustomization.yaml resource list** yet. The Ingress YAML lives in
the directory but is intentionally not yet applied. We'll apply
it in Phase 5 by adding it to the resource list.

### Phase 4 — Deploy v2 and verify (low-risk, autonomous)

Push, wait for Flux to apply.

- mariadb pod comes up, runs initdb against fresh datadir.
- ConfigMap-mounted SQL dump executes from
  `/docker-entrypoint-initdb.d/`. (If dump exceeded 1 MiB and we
  went to option 2, a separate init job runs the restore.)
- wordpress pod comes up, mounts `wp-content/`, generates a clean
  `wp-config.php` from env, connects to mariadb service, serves
  on port 80.
- Smoke-test via `kubectl port-forward svc/wordpress -n
  wordpress-micah-mmm-v2 8080:80` and curl:
  - `curl -H 'Host: mmm.willeke.com' http://localhost:8080/` → 200
  - `curl -H 'Host: mmm.willeke.com' http://localhost:8080/wp-json/wp/v2/posts` → 200, returns posts
  - `curl -H 'Host: mmm.willeke.com' http://localhost:8080/wp-login.php` → 200
- Log into wp-admin via port-forward.
- Confirm theme renders, settings present, media library has the
  expected files.

**Hold here.** Don't proceed to cutover without explicit user
green light. v2 stack is fully up and serving from its own data;
old stack is untouched and serving live traffic.

### Phase 5 — Cutover (requires user approval; brief downtime)

When green-lit:

1. Final delta from old → v2 (per "Cutover model" above).
2. Pre-stage TLS secret in v2 namespace.
3. Apply v2 Ingress, delete old Ingress.
4. Verify `https://mmm.willeke.com/` returns 200 and renders.
5. Browse around as a sanity check.

Expected downtime: <2 min during step 3 (Ingress swap and v2 pod
swap from "no traffic" to "serving").

### Phase 6 — Soak (passive, days)

Leave the old namespace running for at least 48-72 hours scaled
to 0 wordpress pods (mariadb pod up, available for emergency
backup pull). Browse mmm.willeke.com daily. If anything fails,
swap Ingress back per "Rollback at any point during cutover."

### Phase 7 — Decommission old (after soak, manual)

- Remove `apps/production/wordpress-micah-mmm/` from
  `apps/production/kustomization.yaml` (if listed).
- Flux removes the namespace + its resources.
- PVs are `Retain` policy, so hostPath data stays as a final
  backup. Manually delete
  `/mnt/thedatapool/app-data/wordpress-micah-mmm/` after another
  week or two if confident.
- Rename `wordpress-micah-mmm-v2` to `wordpress-micah-mmm` in a
  follow-up commit *or* leave as `-v2` forever (low cost; signals
  there's been a migration). My recommendation: leave as `-v2`
  for one full year, then rename.

### Phase 8 — Docs cleanup (after Phase 7)

(Per user direction)

- Revise `README.md` "Image source caveats" section: stop describing
  the (now-removed) wordpress-micah-mmm workload's specifics, lead
  with a flat "Do not use `bitnami/*` runtime images in this repo"
  rule and the concise reasoning.
- Add a note to `AGENTS.md` so an agent picking up future work
  doesn't reach for bitnami charts/images.
- Update `docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/summary.md`
  with a closing pointer to this migration.

## Safety checkpoints (where to pause)

| After phase | What to verify | If wrong, what to do |
|---|---|---|
| 1 — Backup | Files are non-empty and contain expected content (CREATE TABLE, themes/, plugins/) | Re-run; check pod paths |
| 2 — Stage data | Files materialize at `/mnt/thedatapool/.../wordpress-micah-mmm-v2/` with correct ownership | Re-rsync; fix ownership |
| 3 — Manifests | `kubectl kustomize` renders clean | Fix yaml |
| 4 — Deploy v2 | Pods Ready; port-forward smoke test passes | Investigate; can scale v2 to 0 with no impact on live site |
| **5 — Cutover** | **PAUSE FOR USER APPROVAL** | — |
| 5 — Post-cutover | `https://mmm.willeke.com/` returns 200, renders, REST API works | Rollback ingress + scale old back up |
| 6 — Soak | Daily browse passes | Same as cutover rollback |
| 7 — Decommission | Old namespace removed cleanly | Restore from git (PVs Retain → data still on disk) |

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `wp-content/` contains absolute paths to `/opt/bitnami/...` (themes, plugins, uploads referencing them) | Low | Pages broken | Grep `wp-content/` for `/opt/bitnami` after rsync. If hits, decide per-case (sed-replace or update WP options.siteurl) |
| Plugin/theme stores filesystem paths in DB | Medium | Plugin malfunction | Surveys after Phase 4 smoke test; fix with WP-CLI or wp_options edit |
| WP-CLI not present in official image | High (it isn't bundled) | Inconvenience | Install via `apt` in a sidecar init container if needed for cutover-time DB ops |
| MariaDB authentication plugin mismatch (Bitnami may use a non-default auth plugin) | Low | Pod can't connect | Default for MariaDB 12.x is `mysql_native_password`; `caching_sha2_password` is MySQL not MariaDB. Should be safe. Verify after Phase 4. |
| TLS cert reissuance race during Ingress swap | Low | brief 5xx | Pre-stage TLS secret in v2 namespace (Phase 5 step 6) |
| Ingress controller picks the wrong Ingress momentarily | Low | momentary 5xx | Delete old Ingress immediately after creating new |
| ConfigMap > 1 MiB | Low (small site) | Restore path change | Phase 1 reports the size; fall back to init-container restore from hostPath if exceeded |
| Salts mismatched (login cookies invalidated) | Low | Users logged out (this is Micah only — he can re-login) | Acceptable; not a true risk |

## Out of scope, on the list for later

- WordPress version bump (separate concern; after vendor swap is stable).
- MariaDB version bump (same).
- A general "image source rules for this repo" doc replacing the
  current `README.md` bitnami warning — covered in Phase 8.

## Authoritative references

- Bitnami announcement: <https://github.com/bitnami/containers/issues/83267>
- Broadcom press release: <https://news.broadcom.com/app-dev/broadcom-introduces-bitnami-secure-images-for-production-ready-containerized-applications>
- Official wordpress image: <https://hub.docker.com/_/wordpress> (tag matrix at <https://hub.docker.com/_/wordpress/tags>)
- Official mariadb image: <https://hub.docker.com/_/mariadb>
- Companion spec: `docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/`

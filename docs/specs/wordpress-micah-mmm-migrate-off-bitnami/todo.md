# wordpress-micah-mmm migration — TODO

Companion to [`plan.md`](./plan.md). Flat, actionable, in execution
order. Each item is small enough to commit on its own.

## Phase 1 — Backup (safe, autonomous)

- [x] Identify exact pod names and container names for old wordpress + mariadb
- [x] `mysqldump --all-databases` from old mariadb pod → `/tmp/wpmicah-migration/backup-<ts>.sql`
- [x] `tar czf` of `/opt/bitnami/wordpress/wp-content/` from old wordpress pod → `/tmp/wpmicah-migration/wp-content-<ts>.tar.gz`
- [x] Extract 8 salt constants from old `wp-config.php` → `/tmp/wpmicah-migration/salts-<ts>.txt`
- [x] Record sizes + sha256sums of all three files in spec dir
- [x] Spot-check SQL dump contains `CREATE TABLE` for `wp_options`, `wp_users`, `wp_posts`
- [x] Spot-check tarball lists `themes/`, `plugins/`, `uploads/` subdirs
- [x] Print SQL dump size and decide ConfigMap-vs-init-container restore path (>1 MiB → init container)
- [x] Grep `wp-content/` for `/opt/bitnami` references that would need rewriting

## Phase 2 — Stage v2 data on nas (safe, autonomous)

- [x] `kubectl apply` a one-shot Job that mounts nas hostPath and creates `/mnt/thedatapool/app-data/wordpress-micah-mmm-v2/{mariadb,wp-content}/`
- [x] Job: chown mariadb dir to 999:999 (official mariadb uid:gid)
- [x] Job: chown wp-content dir to 33:33 (www-data)
- [x] Job: unpack the `wp-content-<ts>.tar.gz` into the v2 wp-content dir, preserving permissions
- [x] Verify on-disk: `ls -la /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/` shows expected subtrees
- [x] Delete the one-shot Job

## Phase 3 — Write v2 manifests (safe, autonomous)

- [x] `apps/production/wordpress-micah-mmm-v2/kustomization.yaml`
- [x] `apps/production/wordpress-micah-mmm-v2/namespace.yaml`
- [x] `apps/production/wordpress-micah-mmm-v2/pv-mariadb.yaml` (hostPath, Retain, RWO)
- [x] `apps/production/wordpress-micah-mmm-v2/pv-wp-content.yaml` (hostPath, Retain, RWO)
- [x] `apps/production/wordpress-micah-mmm-v2/pvc-mariadb.yaml`
- [x] `apps/production/wordpress-micah-mmm-v2/pvc-wp-content.yaml`
- [x] `apps/production/wordpress-micah-mmm-v2/.env.secret.wordpress-creds` — plaintext source
  - WORDPRESS_DB_HOST, WORDPRESS_DB_USER, WORDPRESS_DB_PASSWORD, WORDPRESS_DB_NAME, WORDPRESS_TABLE_PREFIX
  - MARIADB_ROOT_PASSWORD
  - WORDPRESS_AUTH_KEY, WORDPRESS_SECURE_AUTH_KEY, WORDPRESS_LOGGED_IN_KEY, WORDPRESS_NONCE_KEY
  - WORDPRESS_AUTH_SALT, WORDPRESS_SECURE_AUTH_SALT, WORDPRESS_LOGGED_IN_SALT, WORDPRESS_NONCE_SALT
- [x] sops-encrypt → `apps/production/wordpress-micah-mmm-v2/.env.secret.wordpress-creds.encrypted`
- [x] Delete plaintext `.env.secret.wordpress-creds` after encrypting
- [x] `configmap-mariadb-initdb.yaml` (or alternative init-container path if dump > 1 MiB)
- [x] `statefulset-mariadb.yaml` — `mariadb:12.2.2-noble`, mounts datadir at `/var/lib/mysql`, mounts initdb ConfigMap at `/docker-entrypoint-initdb.d/`
- [x] `service-mariadb.yaml` — ClusterIP, port 3306, selector targets the StatefulSet
- [x] `deployment-wordpress.yaml` — `wordpress:6.9.1-php8.3-apache`, mounts wp-content under `/var/www/html/wp-content/`, env vars from Secret
- [x] `service-wordpress.yaml` — ClusterIP, port 80
- [x] `ingress-wordpress.yaml` — file present but NOT listed in kustomization.yaml until Phase 5
- [x] Wire `wordpress-micah-mmm-v2` into `apps/production/kustomization.yaml`
- [x] `kubectl kustomize apps/production/wordpress-micah-mmm-v2/` renders clean
- [x] Commit + push

## Phase 4 — Deploy v2, verify (low-risk, autonomous)

- [x] Wait for Flux to reconcile
- [x] Watch mariadb pod come up and finish initdb (`docker-entrypoint-initdb.d/` execution)
- [x] Verify restore: exec into mariadb pod, `SHOW DATABASES`, `USE bn_wordpress`, `SHOW TABLES`, `SELECT COUNT(*) FROM wp_posts` matches old
- [x] Verify users + grants restored: `SELECT user FROM mysql.user`
- [x] Watch wordpress pod come up
- [x] Verify wordpress pod logs: clean Apache startup, no PHP fatal errors
- [x] `kubectl port-forward svc/wordpress -n wordpress-micah-mmm-v2 8080:80`
- [x] `curl -H 'Host: mmm.willeke.com' http://localhost:8080/` returns 200, expected title
- [x] `curl -H 'Host: mmm.willeke.com' http://localhost:8080/wp-json/wp/v2/posts` returns 200, posts present
- [x] `curl -H 'Host: mmm.willeke.com' http://localhost:8080/wp-login.php` returns 200
- [x] Browser via port-forward: log into wp-admin, browse site, theme renders, media library has expected files
- [x] **HOLD** — write a status comment for the user to review

## Phase 5 — Cutover (USER APPROVAL REQUIRED)

- [x] User green-lights cutover
- [x] Scale old wordpress deployment to 0 (stops further DB writes)
- [x] Take a final mysqldump from old mariadb → `final-<ts>.sql`
- [x] Drop bn_wordpress in v2, restore final dump
- [x] Rsync any wp-content delta from old hostPath to v2 hostPath
- [x] Copy current TLS secret to v2 namespace
  - `kubectl get secret mmm-willeke-com-tls -n wordpress-micah-mmm -o yaml | sed 's/namespace: wordpress-micah-mmm/namespace: wordpress-micah-mmm-v2/' | kubectl apply -f -`
- [x] Add `ingress-wordpress.yaml` to the v2 kustomization.yaml resource list
- [x] Commit + push (the Ingress add)
- [x] Wait for Flux to apply
- [x] Delete old Ingress: `kubectl delete ingress -n wordpress-micah-mmm <name>`
- [x] Verify `https://mmm.willeke.com/` returns 200 from the v2 pod
- [x] Verify `https://mmm.willeke.com/wp-login.php` returns 200
- [x] Verify TLS cert serves correctly (no Let's Encrypt rate-limit issue)
- [x] Browse site end-to-end as smoke test

## Phase 6 — Soak (SKIPPED at user direction)

User asked to "clean up" immediately rather than wait the planned
48-72h soak. Skipped. The legacy hostPath data is still on disk
as a passive rollback artifact, so the safety net the soak was
meant to preserve is still present even without the wait.

## Phase 7 — Decommission old

- [x] Remove `apps/production/wordpress-micah-mmm` from `apps/production/kustomization.yaml` (commit `cf2ba3f`)
- [x] Commit + push
- [x] Verify Flux removes the namespace + its resources
- [x] hostPath data `/mnt/thedatapool/app-data/wordpress-micah-mmm/` retained (PV reclaim policy = Retain)
- [ ] **Outstanding:** delete the retained hostPath data on `nas` after ~1 week of stable v2 operation.

## Phase 8 — Docs cleanup (after Phase 7)

- [x] Revise `README.md` "Image source caveats" section: lead with "Do not use `bitnami/*` runtime images here" rule, drop the workload-specific narrative since no workload remains
- [x] Add a short note to `AGENTS.md` warning future agents off bitnami images with the concise reason (no pin, silent major version rolls, WP example: `bitnami/wordpress:latest` rolled 6.x → 7.x on day-of-release)
- [x] Add a closing pointer in `docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/summary.md` to this migration
- [x] Write `summary.md` in this spec dir documenting how it went

## Rollback procedures (reference — not invoked)

The migration completed without any rollback. The procedures below
are kept for reference so they're available if anything degrades
later. Note that with the legacy namespace removed (Phase 7), the
relevant rollback artifact now is the hostPath data at
`/mnt/thedatapool/app-data/wordpress-micah-mmm/` on `nas` — re-mount
that into a fresh stack if you need to restore.

### Catastrophic — v2 broken AND v2 data corrupted

- Spin up a fresh wordpress-upstream overlay pointing at the
  legacy hostPath dirs read-only as a snapshot source.
- Take a `mysqldump --all-databases` from a temporary mariadb
  container mounting the legacy mariadb datadir.
- Restore the dump into a fresh v2 stack.

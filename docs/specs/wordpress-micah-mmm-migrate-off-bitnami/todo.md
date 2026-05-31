# wordpress-micah-mmm migration — TODO

Companion to [`plan.md`](./plan.md). Flat, actionable, in execution
order. Each item is small enough to commit on its own.

## Phase 1 — Backup (safe, autonomous)

- [ ] Identify exact pod names and container names for old wordpress + mariadb
- [ ] `mysqldump --all-databases` from old mariadb pod → `/tmp/wpmicah-migration/backup-<ts>.sql`
- [ ] `tar czf` of `/opt/bitnami/wordpress/wp-content/` from old wordpress pod → `/tmp/wpmicah-migration/wp-content-<ts>.tar.gz`
- [ ] Extract 8 salt constants from old `wp-config.php` → `/tmp/wpmicah-migration/salts-<ts>.txt`
- [ ] Record sizes + sha256sums of all three files in spec dir
- [ ] Spot-check SQL dump contains `CREATE TABLE` for `wp_options`, `wp_users`, `wp_posts`
- [ ] Spot-check tarball lists `themes/`, `plugins/`, `uploads/` subdirs
- [ ] Print SQL dump size and decide ConfigMap-vs-init-container restore path (>1 MiB → init container)
- [ ] Grep `wp-content/` for `/opt/bitnami` references that would need rewriting

## Phase 2 — Stage v2 data on nas (safe, autonomous)

- [ ] `kubectl apply` a one-shot Job that mounts nas hostPath and creates `/mnt/thedatapool/app-data/wordpress-micah-mmm-v2/{mariadb,wp-content}/`
- [ ] Job: chown mariadb dir to 999:999 (official mariadb uid:gid)
- [ ] Job: chown wp-content dir to 33:33 (www-data)
- [ ] Job: unpack the `wp-content-<ts>.tar.gz` into the v2 wp-content dir, preserving permissions
- [ ] Verify on-disk: `ls -la /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/` shows expected subtrees
- [ ] Delete the one-shot Job

## Phase 3 — Write v2 manifests (safe, autonomous)

- [ ] `apps/production/wordpress-micah-mmm-v2/kustomization.yaml`
- [ ] `apps/production/wordpress-micah-mmm-v2/namespace.yaml`
- [ ] `apps/production/wordpress-micah-mmm-v2/pv-mariadb.yaml` (hostPath, Retain, RWO)
- [ ] `apps/production/wordpress-micah-mmm-v2/pv-wp-content.yaml` (hostPath, Retain, RWO)
- [ ] `apps/production/wordpress-micah-mmm-v2/pvc-mariadb.yaml`
- [ ] `apps/production/wordpress-micah-mmm-v2/pvc-wp-content.yaml`
- [ ] `apps/production/wordpress-micah-mmm-v2/.env.secret.wordpress-creds` — plaintext source
  - WORDPRESS_DB_HOST, WORDPRESS_DB_USER, WORDPRESS_DB_PASSWORD, WORDPRESS_DB_NAME, WORDPRESS_TABLE_PREFIX
  - MARIADB_ROOT_PASSWORD
  - WORDPRESS_AUTH_KEY, WORDPRESS_SECURE_AUTH_KEY, WORDPRESS_LOGGED_IN_KEY, WORDPRESS_NONCE_KEY
  - WORDPRESS_AUTH_SALT, WORDPRESS_SECURE_AUTH_SALT, WORDPRESS_LOGGED_IN_SALT, WORDPRESS_NONCE_SALT
- [ ] sops-encrypt → `apps/production/wordpress-micah-mmm-v2/.env.secret.wordpress-creds.encrypted`
- [ ] Delete plaintext `.env.secret.wordpress-creds` after encrypting
- [ ] `configmap-mariadb-initdb.yaml` (or alternative init-container path if dump > 1 MiB)
- [ ] `statefulset-mariadb.yaml` — `mariadb:12.2.2-noble`, mounts datadir at `/var/lib/mysql`, mounts initdb ConfigMap at `/docker-entrypoint-initdb.d/`
- [ ] `service-mariadb.yaml` — ClusterIP, port 3306, selector targets the StatefulSet
- [ ] `deployment-wordpress.yaml` — `wordpress:6.9.1-php8.3-apache`, mounts wp-content under `/var/www/html/wp-content/`, env vars from Secret
- [ ] `service-wordpress.yaml` — ClusterIP, port 80
- [ ] `ingress-wordpress.yaml` — file present but NOT listed in kustomization.yaml until Phase 5
- [ ] Wire `wordpress-micah-mmm-v2` into `apps/production/kustomization.yaml`
- [ ] `kubectl kustomize apps/production/wordpress-micah-mmm-v2/` renders clean
- [ ] Commit + push

## Phase 4 — Deploy v2, verify (low-risk, autonomous)

- [ ] Wait for Flux to reconcile
- [ ] Watch mariadb pod come up and finish initdb (`docker-entrypoint-initdb.d/` execution)
- [ ] Verify restore: exec into mariadb pod, `SHOW DATABASES`, `USE bn_wordpress`, `SHOW TABLES`, `SELECT COUNT(*) FROM wp_posts` matches old
- [ ] Verify users + grants restored: `SELECT user FROM mysql.user`
- [ ] Watch wordpress pod come up
- [ ] Verify wordpress pod logs: clean Apache startup, no PHP fatal errors
- [ ] `kubectl port-forward svc/wordpress -n wordpress-micah-mmm-v2 8080:80`
- [ ] `curl -H 'Host: mmm.willeke.com' http://localhost:8080/` returns 200, expected title
- [ ] `curl -H 'Host: mmm.willeke.com' http://localhost:8080/wp-json/wp/v2/posts` returns 200, posts present
- [ ] `curl -H 'Host: mmm.willeke.com' http://localhost:8080/wp-login.php` returns 200
- [ ] Browser via port-forward: log into wp-admin, browse site, theme renders, media library has expected files
- [ ] **HOLD** — write a status comment for the user to review

## Phase 5 — Cutover (USER APPROVAL REQUIRED)

- [ ] User green-lights cutover
- [ ] Scale old wordpress deployment to 0 (stops further DB writes)
- [ ] Take a final mysqldump from old mariadb → `final-<ts>.sql`
- [ ] Drop bn_wordpress in v2, restore final dump
- [ ] Rsync any wp-content delta from old hostPath to v2 hostPath
- [ ] Copy current TLS secret to v2 namespace
  - `kubectl get secret mmm-willeke-com-tls -n wordpress-micah-mmm -o yaml | sed 's/namespace: wordpress-micah-mmm/namespace: wordpress-micah-mmm-v2/' | kubectl apply -f -`
- [ ] Add `ingress-wordpress.yaml` to the v2 kustomization.yaml resource list
- [ ] Commit + push (the Ingress add)
- [ ] Wait for Flux to apply
- [ ] Delete old Ingress: `kubectl delete ingress -n wordpress-micah-mmm <name>`
- [ ] Verify `https://mmm.willeke.com/` returns 200 from the v2 pod
- [ ] Verify `https://mmm.willeke.com/wp-login.php` returns 200
- [ ] Verify TLS cert serves correctly (no Let's Encrypt rate-limit issue)
- [ ] Browse site end-to-end as smoke test

## Phase 6 — Soak (passive, days)

- [ ] T+24h: browse site, check pod restarts, confirm logs clean
- [ ] T+48h: same
- [ ] T+72h: decide go/no-go for Phase 7

## Phase 7 — Decommission old (after soak)

- [ ] Remove `apps/production/wordpress-micah-mmm` from `apps/production/kustomization.yaml` (if listed)
- [ ] Commit + push
- [ ] Verify Flux removes the namespace + its resources
- [ ] hostPath data `/mnt/thedatapool/app-data/wordpress-micah-mmm/` retained (PV reclaim policy = Retain)
- [ ] Note: schedule manual deletion of retained hostPath data ~2 weeks later

## Phase 8 — Docs cleanup (after Phase 7)

- [ ] Revise `README.md` "Image source caveats" section: lead with "Do not use `bitnami/*` runtime images here" rule, drop the workload-specific narrative since no workload remains
- [ ] Add a short note to `AGENTS.md` warning future agents off bitnami images with the concise reason (no pin, silent major version rolls, WP example: `bitnami/wordpress:latest` rolled 6.x → 7.x on day-of-release)
- [ ] Add a closing pointer in `docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/summary.md` to this migration
- [ ] Write `summary.md` in this spec dir documenting how it went

## Rollback procedures

For reference — not a forward step, but documented so they're ready
if needed.

### During Phase 5 cutover

- [ ] Scale v2 wordpress to 0
- [ ] Scale old wordpress back to 1
- [ ] Restore old Ingress (re-apply from git)
- [ ] Delete v2 Ingress

### Post-cutover, during Phase 6 soak

- [ ] Same as during cutover. Old namespace mariadb still has the
      data from the moment we cut over (writes after cutover went to
      v2 only).
- [ ] Optional: dump v2 mariadb back into old to catch up writes since
      cutover. **Lossy if not done — any new content created on v2
      will be missing after rolling back to old.**

### Catastrophic — both v2 broken AND data corrupted

- [ ] Phase 1 backup file `backup-<ts>.sql` is the last clean
      snapshot of the old DB. Restore that to a brand-new namespace
      and rebuild from there.
- [ ] `wp-content-<ts>.tar.gz` is the matching files backup.

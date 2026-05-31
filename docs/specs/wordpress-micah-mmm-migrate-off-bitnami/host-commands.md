# Host commands for wordpress-micah-mmm Bitnami → upstream migration

This is the runbook for the host-side work you need to do on the
`nas` node (or wherever has shell access to `/mnt/thedatapool/`).
The repo-side work (manifests, secret, plan/todo docs) is already
committed. After you finish the host steps below, I'll wire the v2
overlay into `apps/production/kustomization.yaml` and Flux will
deploy v2.

Companion docs:
- [`plan.md`](./plan.md) — the full migration design and risk
  register.
- [`todo.md`](./todo.md) — flat checklist tracking every action.

## What you need

- Root (or `sudo`) access on the host that owns
  `/mnt/thedatapool/`.
- `kubectl` configured for the `nas` cluster (i.e.,
  `kubectl --context nas` works).
- A few hundred MB of free space on `/mnt/thedatapool/` (the
  wp-content tarball + the SQL dump; both small for this site).

## Quick sanity check (do this first)

```bash
# Confirm you're targeting the right cluster
kubectl --context nas -n wordpress-micah-mmm get pods

# Expected output: wordpress-* and wordpress-mariadb-0, both Running 1/1
```

## Step 1 — Create the v2 hostPath dirs with correct ownership

The official Docker images run as different UIDs than the Bitnami
images, so the v2 dirs need different ownership:

| Dir | UID:GID | Why |
|---|---|---|
| `mariadb` | `999:999` | Official `library/mariadb` runs as `mysql` user, UID 999. |
| `mariadb-initdb` | `999:999` (or world-readable) | mariadb container reads from here on first init. |
| `wp-content` | `33:33` | Official `library/wordpress` runs as `www-data`, UID 33. |

```bash
sudo mkdir -p /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/{mariadb,mariadb-initdb,wp-content}
sudo chown 999:999 /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb
sudo chown 999:999 /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb
sudo chown 33:33   /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content

# Confirm:
ls -la /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/
```

Expected: three empty dirs with the right owners.

## Step 2 — Dump the database into the mariadb-initdb dir

The dump becomes the official mariadb container's first-start
init script (it'll auto-execute it because the datadir is empty
and the file lives in `/docker-entrypoint-initdb.d/`).

```bash
# Take a full dump from the old mariadb pod (root pw is in the pod's
# env via a file secret). Stream directly to the v2 hostPath as root.
sudo bash -c '
kubectl --context nas -n wordpress-micah-mmm exec wordpress-mariadb-0 -c mariadb -- \
  bash -c "
    mariadb-dump \
      -uroot \
      -p\$(cat \$MARIADB_ROOT_PASSWORD_FILE) \
      --all-databases \
      --routines \
      --triggers \
      --events \
      --single-transaction \
      --add-drop-database
  " > /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb/restore.sql
'

# Verify it produced something non-trivial and contains expected schema
sudo ls -la /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb/restore.sql
sudo grep -c '^CREATE TABLE' /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb/restore.sql
sudo grep -c 'CREATE DATABASE.*bitnami_wordpress' /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb/restore.sql

# Fix ownership so mariadb container (uid 999) can read it
sudo chown 999:999 /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb/restore.sql
sudo chmod 0444    /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/mariadb-initdb/restore.sql
```

Expected:
- `restore.sql` is several MB at minimum (system DBs + bn_wordpress).
- `CREATE TABLE` count is in the dozens.
- `CREATE DATABASE.*bitnami_wordpress` count is at least 1.

## Step 3 — Copy `wp-content/` from old to v2

The wp-content tree is on the same filesystem already (PVC of old
is hostPath-backed). Direct `rsync` is faster than going through
the pod.

```bash
sudo rsync -a --info=stats2 \
  /mnt/thedatapool/app-data/wordpress-micah-mmm/wordpress/wp-content/ \
  /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/

# Chown the copy to the UID the official wordpress container runs as
sudo chown -R 33:33 /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/

# Sanity check what landed
sudo ls /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/
sudo du -sh /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/
```

Expected: `themes/`, `plugins/`, `uploads/`, possibly `mu-plugins/`
and `languages/`. Size depends on uploaded media.

## Step 4 — (Optional) Sanity-grep wp-content for Bitnami-specific paths

If anything inside wp-content hard-references `/opt/bitnami/...`
we'd want to know before cutover. A few hits in cache files are
normal noise; many hits in theme/plugin PHP would be a real concern
to flag.

```bash
sudo grep -rl /opt/bitnami /mnt/thedatapool/app-data/wordpress-micah-mmm-v2/wp-content/ 2>/dev/null | head -20
```

Expected: empty or a handful of cache/log files. If a theme or
plugin's PHP source matches, **stop and tell me before continuing**
— that's a migration risk worth thinking through.

## Step 5 — Tell me you're done

Once steps 1-3 are complete and step 4 looks clean, ping me. I'll
do the next phase from the repo side:

1. Add `wordpress-micah-mmm-v2` to
   `apps/production/kustomization.yaml`.
2. Commit + push.
3. Watch Flux roll the v2 namespace and verify the mariadb
   restore + wordpress pod come up cleanly.
4. Port-forward to v2 wordpress for a private smoke test.
5. Pause for your **browser-side green-light** before the
   final Ingress cutover (Phase 5 of the plan).

Until I do step 1 above, **nothing in v2 deploys**. Flux is not
yet aware of the new namespace. Live `mmm.willeke.com` traffic
keeps flowing to the existing old stack.

## Backup of host commands' outputs

Save the outputs of `step 1 ls`, `step 2 verify`, and `step 3 du`
in a paste somewhere I can see — useful both for verifying success
and for a post-mortem if anything goes sideways.

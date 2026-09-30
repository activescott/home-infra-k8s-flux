# wordpress-upstream — reusable WordPress + MariaDB base

Hand-written manifests for an upstream WordPress + MariaDB stack
using the Docker official images. Replaces the legacy Bitnami chart
(see top-level README's "Image source caveats" — do not add new
`bitnami/*` runtime images here).

## What this base ships

| Resource               | Image                           | Notes                                                                                                                                                                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deployment/wordpress` | `wordpress:7.1.2-php8.3-apache` | RWO PVC → `strategy: Recreate`. uid:gid 33:33 (www-data). Read-only root and core. wp-content is writable except `plugins/`, `themes/` and `mu-plugins/`, and PHP runs only from those three. |
| `Service/wordpress`    | —                               | ClusterIP, port 80.                                                                                                                                                                           |
| `StatefulSet/mariadb`  | `mariadb:12.2.2-noble`          | 1 replica. uid:gid 999:999 (mysql).                                                                                                                                                           |
| `Service/mariadb`      | —                               | Headless, port 3306.                                                                                                                                                                          |

Image versions are pinned in the base. All tenant overlays inherit
the same versions; bump them here for everyone at once.

## What every tenant overlay must provide

In the tenant namespace:

1. **PVCs** with these exact names — the base mounts them by name:
   - `wordpress-mariadb-data` → mounted at `/var/lib/mysql`
   - `wordpress-mariadb-initdb` → mounted at `/docker-entrypoint-initdb.d` (read-only). Drop a `restore.sql` here for first-init DB seeding; the mariadb entrypoint will execute it before opening for connections.
   - `wordpress-wp-content` → mounted at `/var/www/html/wp-content`,
     with its `plugins/`, `themes/` and `mu-plugins/` mounted again
     read-only on top. The restore must leave all three directories
     in place, owned by 33:33 like the rest of wp-content, even if
     `mu-plugins/` is empty. A missing one does not stop the pod: the
     kubelet creates it, owned by root, and WordPress reads it as
     empty, but adding one on the host then needs root. The init
     container runs as uid 33 and fails if `plugins/` or `themes/`
     exists and is not writable by it, since it copies the bundled
     ones in. Plugin and theme changes happen on the host, since
     WordPress can no longer write those directories.

2. **`Secret/wordpress-creds`** with these 12 keys (sops-encrypted
   dotenv via `secretGenerator` is the project convention):

   ```
   mariadb-root-password
   wordpress-db-user, wordpress-db-password, wordpress-db-name
   wordpress-auth-key,  wordpress-secure-auth-key,
   wordpress-logged-in-key, wordpress-nonce-key,
   wordpress-auth-salt, wordpress-secure-auth-salt,
   wordpress-logged-in-salt, wordpress-nonce-salt
   ```

   The 8 WP key/salt values should be fresh-random per tenant; WP
   uses them to sign cookies and nonces. The official image does not
   generate defaults, so omitting any of them breaks login.

3. **`Ingress`** claiming the tenant's hostname, routing `/` to the
   `wordpress` Service. The base does not ship one — Ingress is
   intrinsically tenant-specific.

4. **A patch setting `WORDPRESS_CONFIG_EXTRA`** on the `wordpress`
   container, defining `WP_HOME` and `WP_SITEURL` constants to the
   tenant's public URL. WP's `wp_options.{home,siteurl}` are not
   reliable across migrations; setting these in wp-config.php pins
   the URL deterministically per environment.

   The same value must also carry the hardening constants. Core is
   read-only, so WordPress must not try to update it, and plugins and
   themes cannot be installed or edited from the dashboard.

   Example:

   ```yaml
   - name: WORDPRESS_CONFIG_EXTRA
     value: |
       define('WP_HOME',    'https://example.com');
       define('WP_SITEURL', 'https://example.com');
       define('WP_AUTO_UPDATE_CORE', false);
       define('DISALLOW_FILE_EDIT', true);
       define('DISALLOW_FILE_MODS', true);
   ```

## Preview and going live

For `apps/production/wordpress-micah-mmm-v2/`. The preview is
`ingress.yaml` added to `resources` with the offline patch removed;
going live is deleting the marked `lan-only` line in `ingress.yaml`.

After each apply, before going further, check Traefik's log in Loki
for a router it could not build. A rule Traefik cannot parse drops
only that router, and the catch-all then serves wp-admin to whoever
it admits. This must return nothing:

```logql
{namespace="kube-system", container="traefik"} |= "error while parsing rule"
```

In the preview, wp-cron must be able to reach the site through
Traefik. Expect `200`; a hang means the NetworkPolicy does not match
the path the request takes:

```sh
kubectl --context nas -n wordpress-micah-mmm-v2 exec deploy/wordpress -- \
  curl -sS -o /dev/null -w '%{http_code}\n' https://mmm.willeke.com/wp-cron.php
```

After going live, from a machine off the LAN, each of these must
return `403`, and `/` must return `200`. They spell the admin paths
with encoded dot segments, which Traefik and Apache read differently:

```sh
for p in /%2e/wp-login.php /a/%2e%2e/wp-login.php /%2e/xmlrpc.php \
         /x/%2e%2e/wp-admin/admin-ajax.php /; do
  printf '%s %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --path-as-is "https://mmm.willeke.com$p")" "$p"
done
```

## Reference overlay

`apps/production/wordpress-micah-mmm-v2/` is the working example.
Use it as a template when adding a new WordPress tenant.

## Related

- `docs/specs/wordpress-micah-mmm-migrate-off-bitnami/` — plan,
  todo, host-commands runbook, and (post-migration) summary for the
  Bitnami-to-upstream migration that produced this base.

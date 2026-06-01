# wordpress-upstream — reusable WordPress + MariaDB base

Hand-written manifests for an upstream WordPress + MariaDB stack
using the Docker official images. Replaces the legacy Bitnami chart
(see top-level README's "Image source caveats" — do not add new
`bitnami/*` runtime images here).

## What this base ships

| Resource | Image | Notes |
|---|---|---|
| `Deployment/wordpress` | `wordpress:6.9.1-php8.3-apache` | RWO PVC → `strategy: Recreate`. uid:gid 33:33 (www-data). |
| `Service/wordpress` | — | ClusterIP, port 80. |
| `StatefulSet/mariadb` | `mariadb:12.2.2-noble` | 1 replica. uid:gid 999:999 (mysql). |
| `Service/mariadb` | — | Headless, port 3306. |

Image versions are pinned in the base. All tenant overlays inherit
the same versions; bump them here for everyone at once.

## What every tenant overlay must provide

In the tenant namespace:

1. **PVCs** with these exact names — the base mounts them by name:
   - `wordpress-mariadb-data` → mounted at `/var/lib/mysql`
   - `wordpress-mariadb-initdb` → mounted at `/docker-entrypoint-initdb.d` (read-only). Drop a `restore.sql` here for first-init DB seeding; the mariadb entrypoint will execute it before opening for connections.
   - `wordpress-wp-content` → mounted at `/var/www/html/wp-content`

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

   Example:
   ```yaml
   - name: WORDPRESS_CONFIG_EXTRA
     value: |
       define('WP_HOME',    'https://example.com');
       define('WP_SITEURL', 'https://example.com');
   ```

## Reference overlay

`apps/production/wordpress-micah-mmm-v2/` is the working example.
Use it as a template when adding a new WordPress tenant.

## Related

- `docs/specs/wordpress-micah-mmm-migrate-off-bitnami/` — plan,
  todo, host-commands runbook, and (post-migration) summary for the
  Bitnami-to-upstream migration that produced this base.

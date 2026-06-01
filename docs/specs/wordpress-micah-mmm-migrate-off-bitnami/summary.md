# wordpress-micah-mmm: migrate off Bitnami — summary

## Outcome

mmm.willeke.com migrated successfully from the Bitnami WordPress
Helm chart to a hand-written kustomize stack using upstream
`library/wordpress:6.9.1-php8.3-apache` and `library/mariadb:12.2.2-noble`.
Same data, same WP/MariaDB versions, vendor swap only. Cutover took
under 2 minutes of perceptible downtime; total session time
(plan + execution + cleanup) was about 3 hours.

## Commits in execution order

| sha | What |
|---|---|
| `ee0576a` | Plan + flat checklist (todo.md). |
| `cada046` | New `apps/base/wordpress-upstream/` + v2 overlay, secret, runbook. Nothing wired into Flux yet. |
| `9a97314` | Fix wp-content rsync path in host-commands runbook (double `wordpress/` subdir caught during Phase 2). |
| `990acba` | Wire v2 into `apps/production/kustomization.yaml`. Initial deploy. |
| `64634ef` | Fix v2 secret: actual mariadb passwords are in the Bitnami subchart's `wordpress-mariadb` Secret (10-byte values), not the SOPS-encrypted `wordpress-creds` Secret (32-byte values). Initial composition pulled from the wrong source; auth failed until corrected. |
| `8771c13` | Cutover: turn `ingress.enabled: false` on legacy HelmRelease + wire v2 `ingress.yaml` + add `WORDPRESS_CONFIG_EXTRA` patch for `WP_HOME`/`WP_SITEURL` (DB has placeholder `https://127.0.0.1` from initial install). |
| `20db5af` | README for `apps/base/wordpress-upstream/`. |
| `cf2ba3f` | Remove legacy `./wordpress-micah-mmm` from `apps/production/kustomization.yaml` — Flux deletes the namespace + HelmRelease. PVs `Retain`, so hostPath data stays. |
| this commit | Post-migration docs cleanup (README rule, AGENTS.md note, this summary, todo.md ticked off). |

## What went right

- **Side-by-side + Retain PVs gave true rollback at every step.**
  At no point did we delete or overwrite live data; the old
  hostPath dirs at `/mnt/thedatapool/app-data/wordpress-micah-mmm/`
  are untouched.
- **mysqldump + rsync was the right data bridge.** Vendor swap is
  transparent at the data layer because MariaDB on-disk format is
  identical across distributions of the same major.minor.patch, and
  WP's `wp-content/` is the same shape regardless of which image
  serves it.
- **WP salt preservation worked.** Reading the 8 salts out of the
  running Bitnami pod's `wp-config.php` and injecting them as
  `WORDPRESS_*_KEY`/`_SALT` env vars on the upstream image
  preserved any existing logged-in sessions.
- **TLS pre-stage avoided a Let's Encrypt re-issuance gap.** Copied
  the existing `mmm-willeke-com-tls` Secret into the v2 namespace
  before the cutover commit, so the new Ingress had an immediately
  valid cert; cert-manager later issued a fresh one in the
  background.

## What went wrong (and what was learned)

### 1. Bitnami chart's mariadb subchart has its own Secret

The `wordpress-creds` Secret (sops-encrypted from
`.env.secret.wordpress-creds`) holds 32-byte values for
`mariadb-password` and `mariadb-root-password`. **Those values are
not actually used by the running MariaDB**. The Bitnami chart's
embedded mariadb subchart generates its own `wordpress-mariadb`
Secret with 10-byte auto-generated values; *those* are what bind
the actual DB users.

I initially built the v2 Secret from the wrong source (the SOPS one
the WP container was configured against, but which mariadb wasn't),
so the v2 pod's env-supplied passwords didn't match the hashes the
mysqldump-restored `mysql.global_priv` carried. Fix in commit
`64634ef`: re-extract from `wordpress-mariadb` Secret.

**Lesson:** when a chart bundles a subchart, the subchart often
has its own auto-generated secret independent of the parent's
"shared" secret. Always identify the secret actually mounted by
the running pod (`kubectl exec ... env | grep _FILE`) before
trusting the named parent secret.

### 2. `wp_options.{home,siteurl}` in the dump are the initial placeholder

Bitnami's chart hard-codes `WP_HOME`/`WP_SITEURL` in its generated
`wp-config.php`, which means the actual WP runtime URL is the
constant — and `wp_options.{home,siteurl}` are left at their
default `https://127.0.0.1` from initial install, never updated.

The upstream `library/wordpress` image generates a vanilla
`wp-config.php` from env vars and does **not** set these
constants by default, so WP falls back to the DB values and
serves asset URLs pointing at `127.0.0.1`. All static assets
break in browser.

Fix in commit `8771c13`: add a `WORDPRESS_CONFIG_EXTRA` env var
in the tenant overlay defining `WP_HOME` and `WP_SITEURL`.

**Lesson:** when migrating a Bitnami-managed WordPress, always
verify `wp_options.home`/`siteurl` are sane in the dump — if they
look like a placeholder, the new stack will need explicit URL
overrides in `wp-config.php`.

### 3. PVC mount layout differed from PV `hostPath` declaration

The legacy PV declared `hostPath:
/mnt/thedatapool/app-data/wordpress-micah-mmm/wordpress`, but the
actual `wp-content/` on disk was at
`/mnt/thedatapool/app-data/wordpress-micah-mmm/wordpress/wordpress/wp-content/`
(double `wordpress`). The Bitnami init populates a nested
`wordpress/` subdir under the PVC mount root.

Fix in commit `9a97314`: corrected the rsync source path in the
host-commands runbook. Worth knowing if you ever need to manually
inspect a Bitnami WP PVC again.

## Security note

During the troubleshooting of the secret mismatch, I had to decode
and compare password bytes from cluster Secrets. The 32-byte
`wordpress-creds.mariadb-root-password` value was briefly visible
as decoded hex in tool output (in the conversation transcript).
That value turned out to be **unused** by the running MariaDB
(the chart's mariadb subchart's auto-generated 10-byte values are
what actually bind), so the exposure is harmless **provided that
value isn't used anywhere else**. User confirmed it isn't.

The actual working 10-byte mariadb passwords (root and
bn_wordpress) were only ever piped via stdin and never appeared
in chat output; only their mysql_native_password hashes (which
are also present in the SQL dump on disk) were echoed.

## Final state in the cluster

```
$ kubectl --context nas get ns | grep wordpress
wordpress-micah-mmm-v2  Active

$ kubectl --context nas get ingress -A | grep mmm
wordpress-micah-mmm-v2  wordpress  traefik  mmm.willeke.com  ...

$ curl -sSI https://mmm.willeke.com/ | head -3
HTTP/2 200
content-type: text/html; charset=UTF-8
server: Apache  # was: Apache before, still Apache; vendor swap was transparent
```

No `bitnami/*` images run in the cluster. No `bitnamicharts/*`
charts are referenced.

## What's left on disk as belt-and-suspenders

- `/mnt/thedatapool/app-data/wordpress-micah-mmm/` — the legacy
  hostPath tree, untouched. Has the live MariaDB datadir and the
  Bitnami-layout `wordpress/wordpress/{wp-config.php,wp-content/}`.
  Safe to delete in a week or two if v2 stays healthy.
- `apps/production/wordpress-micah-mmm/` — manifest directory.
  Left in the repo as historical record of the legacy stack.
  Safe to `git rm -r` in a follow-up commit once you're sure
  you won't need it for reference.

## Follow-up checklist (optional)

- [ ] After ~1 week of stable v2 operation, delete
      `/mnt/thedatapool/app-data/wordpress-micah-mmm/` on `nas`.
- [ ] Optionally `git rm -r apps/production/wordpress-micah-mmm/`
      (sops-encrypted secret is the only real value still inside,
      and it's been confirmed unused).
- [ ] After ~1 year, optionally rename
      `wordpress-micah-mmm-v2` → `wordpress-micah-mmm`
      (namespace rename is a non-trivial move, only do this if
      the `-v2` suffix becomes confusing — low priority).

## Reference

- Plan: [`plan.md`](./plan.md)
- TODO/checklist: [`todo.md`](./todo.md)
- Host runbook: [`host-commands.md`](./host-commands.md)
- The base this migration produced: [`apps/base/wordpress-upstream/README.md`](../../../apps/base/wordpress-upstream/README.md)
- Bitnami distribution change references: see the pin-upgrade spec at [`../wordpress-micah-mmm-bitnami-pin-upgrade/summary.md`](../wordpress-micah-mmm-bitnami-pin-upgrade/summary.md).

# four-in-a-row

[Four in a Row](https://github.com/activescott/four-in-a-row) at
`https://four-in-a-row.activescott.com`: the app Deployment and its Postgres StatefulSet, in
namespace `four-in-a-row-prod`. Same shape as job-accelerator, without the worker or keystore.

## Secrets

`.env.secret.app` (Secret `app-creds`):

- `NODE_ENV`: runtime mode, `production`.
- `DATABASE_URL`: `postgresql://fourinarow:<password>@db:5432/fourinarow`.
- `JWT_SECRET`: signs session cookies.
- `SIGNUP_EMAILS`: addresses that may sign up without an invite, comma separated. Anyone
  else needs an existing account or a pending invite.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`: `relay.email-relay.svc.cluster.local`, `587`,
  `false`.
- `SMTP_USER`, `SMTP_PASS`: `four-in-a-row@relay.local` and its relay password.

`.env.secret.db` (Secret `db-creds`):

- `POSTGRES_DB`, `POSTGRES_USER`: both `fourinarow`. The db probes name them, so they are
  fixed.
- `POSTGRES_PASSWORD`: must match the password in `DATABASE_URL`.

`.env.secret.passkey-challenge.public-key-encrypted.encrypted` (Secret `passkey-challenge`):

- `PASSKEY_CHALLENGE_SECRET`: signs passkey challenge cookies. Piped straight into sops, so
  nobody has seen it.

`SMTP_PASS` must match this app's entry in email-relay's `SMTPD_SASL_USERS`
(`apps/production/email-relay/.env.secret.relay`). Rotation works as for job-accelerator:
every Secret here comes from `secretGenerator`, so a changed value rolls the pod. Rotating
`JWT_SECRET` signs everyone out.

```bash
./scripts/onepassword-secrets.mts show apps/production/four-in-a-row/.env.secret.app
./scripts/onepassword-secrets.mts edit apps/production/four-in-a-row/.env.secret.app
```

### Plain env

| Variable     | Value                                   | Where                       |
| ------------ | --------------------------------------- | --------------------------- |
| `APP_URL`    | `https://four-in-a-row.activescott.com` | `patch-app-deployment.yaml` |
| `FROM_EMAIL` | `four-in-a-row-noreply@activescott.com` | same                        |

## Migrations

An init container named `migrate` runs `prisma migrate deploy` before the app container
starts. It uses `ghcr.io/activescott/four-in-a-row-migrate`, a second target of the app's
Dockerfile that carries the Prisma CLI, the schema and the migrations. This is the decision on
activescott/four-in-a-row#23: the app image cannot drop `@prisma/studio-core` and `@prisma/dev`,
because `prisma migrate deploy` loads them, so the CLI moves to an image that only migrates.

- The init container takes `DATABASE_URL` from `app-creds` and has the app's security context.
  It stays in the `app: app` pod, so the db NetworkPolicy allows it.
- Both images in `kustomization.yaml` carry the marker of `policy-four-in-a-row-app`. The app's
  release workflow pushes both with one version tag, so one policy keeps them on the same
  version. A second ImagePolicy would scan on its own schedule and could split them.
- The app's `docker-entrypoint.sh` still runs `prisma migrate deploy` at boot until the app
  drops the CLI; with the init container ahead of it, that run is a no-op.
- A Job was rejected: Flux applies a Job and the Deployment with no ordering between them, and
  Jobs are immutable, so every image bump needs the Job recreated.
- `ghcr.io/activescott/four-in-a-row-migrate` must be public, or pulled with the same secret
  as the app image.

## Client IP

The app rate-limits sign-in by client IP (20 a minute) and reads it as the last entry of
`X-Forwarded-For`, which is the TCP peer Traefik saw. That is the real client only because:

- the `four-in-a-row` record in `infrastructure/prod/dns/zones/activescott.com.yaml` is DNS
  only (not proxied through Cloudflare), and
- Traefik's Service has `externalTrafficPolicy: Local`, so the peer is not SNAT'd to the
  node.

If the record is ever proxied, every visitor behind one Cloudflare edge address shares a
single limit. Setting the app to trust two hops is not enough on its own: Traefik has no
`forwardedHeaders.trustedIPs`, so it drops the `X-Forwarded-For` Cloudflare sends and the
app would only ever see the edge address. Proxying needs Cloudflare's ranges in Traefik's
trusted IPs and the app reading the second-to-last hop (or `CF-Connecting-IP`), together.

## Database volume

hostPath `/mnt/thedatapool/app-data/four-in-a-row/prod/db-data` (`db-pv.yaml`), mounted at
`/var/lib/postgresql`. postgres:18 keeps its data in `/var/lib/postgresql/18/docker` under
that, so a later major upgrade can sit beside it on the same volume. The container starts as
root and chowns the directory itself, so `DirectoryOrCreate` is enough, as for
job-accelerator.

## Debugging

Logs are in Loki: `{namespace="four-in-a-row-prod", container="app"} |= "db.size"`.

```bash
kubectl --context nas -n four-in-a-row-prod exec -it db-0 -- psql -U fourinarow
```

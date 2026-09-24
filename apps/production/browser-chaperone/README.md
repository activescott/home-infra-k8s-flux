# browser-chaperone

## Prerequisite on the NAS

**The db data directory must exist and be owned by 999:999 before the PV is applied.**
hostPath volumes are not chowned by the kubelet, and the postgres image runs as uid/gid 999.

```bash
ssh nas 'sudo mkdir -p /mnt/thedatapool/app-data/browser-chaperone/prod/db-data \
  && sudo chown -R 999:999 /mnt/thedatapool/app-data/browser-chaperone/prod/db-data'
```

## Secrets

`.env.secret.app` (Secret `app-creds`): `DATABASE_URL`.

`.env.secret.db` (Secret `db-creds`): the Postgres database, role and password.

`.env.secret.app-signin` (Secret `app-signin`): `JWT_SECRET`, `ALLOWED_EMAILS`, and
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` for email-relay.

`.env.secret.internal-api-token` (Secret `internal-api-token`): `INTERNAL_API_TOKEN`, read
by both the app and the browser service.

## Relay password

The app will not start in production without `SMTP_PASS`, and the relay's SASL users are
not set by an agent (`apps/production/email-relay/README.md`):

1. Generate a password: `openssl rand -hex 32`.
2. Append `,browserchaperone@relay.local:<password>` to `SMTPD_SASL_USERS`:
   `./scripts/onepassword-secrets.mts edit apps/production/email-relay/.env.secret.relay`
3. Add `SMTP_PASS=<password>`:
   `./scripts/onepassword-secrets.mts edit apps/production/browser-chaperone/.env.secret.app-signin`
4. Commit both `.encrypted` files.

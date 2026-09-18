# job-accelerator

## Secrets

`.env.secret.app` (Secret `app-creds`):

- `NODE_ENV`: runtime mode, `production`.
- `DATABASE_URL`: full Postgres connection string, including the password.
- `JWT_SECRET`: signs session tokens.
- `ALLOWED_EMAILS`: the only addresses that can sign in.
- `FROM_EMAIL`: the `From:` address on outgoing mail, `noreply@pingpoet.com`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`: point at the email-relay Service.
- `SMTP_USER`, `SMTP_PASS`: SASL login for the relay.

`.env.secret.db` (Secret `db-creds`):

- `POSTGRES_DB`, `POSTGRES_USER`: database and role the app connects as.
- `POSTGRES_PASSWORD`: must match the password embedded in `DATABASE_URL` above.

`SMTP_PASS` must also match this app's entry in email-relay's `SMTPD_SASL_USERS`
(`apps/production/email-relay/.env.secret.relay`).

`APP_URL` (`https://job-accelerator.pingpoet.com`) is not secret, so it's set as a plain
`value:` in `patch-app-deployment.yaml` instead of here.

Read or change either one with:

```bash
./scripts/onepassword-secrets.mts show apps/production/job-accelerator/.env.secret.app
./scripts/onepassword-secrets.mts edit apps/production/job-accelerator/.env.secret.app
```

## One-time setup

The two `.encrypted` files here were created by encrypting straight to the public key and
`SMTP_PASS` was never set. From the repo root:

1. Generate the relay password:

   ```bash
   openssl rand -hex 32
   ```

2. Add this app to the relay's SASL users. Append
   `,jobaccelerator@relay.local:<password>` to `SMTPD_SASL_USERS`:

   ```bash
   ./scripts/onepassword-secrets.mts edit apps/production/email-relay/.env.secret.relay
   ```

3. Add `SMTP_PASS=<password>` here:

   ```bash
   ./scripts/onepassword-secrets.mts edit apps/production/job-accelerator/.env.secret.app
   ```

4. Commit both `.encrypted` files.

## Rotation

Every rotation follows the same steps:

1. Pull the plaintext: `./scripts/onepassword-secrets.mts pull job-accelerator`, plus
   `./scripts/onepassword-secrets.mts pull email-relay` for the relay password.
2. Edit the value(s).
3. Re-encrypt the changed directory or directories: `./scripts/encrypt-env-files.sh <dir>`.
4. Push the plaintext back: `./scripts/onepassword-secrets.mts push --only <group>...`.
5. Commit the `.encrypted` files via a PR.

`app-creds`, `db-creds`, and `relay-creds` all come from `secretGenerator` with no
`disableNameSuffixHash`, so a changed value renames the generated Secret, which rolls the
Deployment or StatefulSet the moment Flux applies it. No manual restart needed.

### Relay password (`SMTP_PASS` / `SMTPD_SASL_USERS`)

Generate a new value with `openssl rand -hex 32` and set it in both files: `SMTP_PASS`
here and this app's entry in email-relay's `SMTPD_SASL_USERS`. They must always match.

### `JWT_SECRET`

Rotating it signs everyone out; every existing session token fails verification on the
next request.

### DB password

Change it in Postgres before or together with the secret, never after. The secret is
useless until the role's actual password matches it.

```bash
kubectl --context nas -n job-accelerator-prod exec -it db-0 -- \
  psql -U jobaccelerator -c "ALTER USER jobaccelerator WITH PASSWORD '<new password>';"
```

Then update `POSTGRES_PASSWORD` and the password embedded in `DATABASE_URL` to match.

## Sending mail

`pingpoet.com` must be onboarded to Cloudflare Email Sending before the relay can send as
`noreply@pingpoet.com`.

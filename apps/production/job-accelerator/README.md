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

These are ordinary plaintext-backed secrets managed through
`./scripts/onepassword-secrets.mts`, group `job-accelerator`. Pull the plaintext with:

```bash
./scripts/onepassword-secrets.mts pull job-accelerator
```

## One-time setup

The two `.encrypted` files here were created by encrypting straight to the public key,
with no plaintext copy ever pushed to 1Password, and `SMTP_PASS` was never set. From the
repo root:

1. Generate the relay password:

   ```bash
   openssl rand -hex 32
   ```

2. Add this app to the relay's SASL users:

   ```bash
   ./scripts/onepassword-secrets.mts pull email-relay
   ```

   Append `,jobaccelerator@relay.local:<password>` to `SMTPD_SASL_USERS` in
   `apps/production/email-relay/.env.secret.relay`, then:

   ```bash
   ./scripts/encrypt-env-files.sh apps/production/email-relay
   ```

3. Decrypt both job-accelerator files to plaintext once:

   ```bash
   SOPS_AGE_KEY_FILE=home-infra-private.agekey sops decrypt \
     --input-type dotenv --output-type dotenv \
     apps/production/job-accelerator/.env.secret.app.encrypted \
     > apps/production/job-accelerator/.env.secret.app
   SOPS_AGE_KEY_FILE=home-infra-private.agekey sops decrypt \
     --input-type dotenv --output-type dotenv \
     apps/production/job-accelerator/.env.secret.db.encrypted \
     > apps/production/job-accelerator/.env.secret.db
   ```

4. Add `SMTP_PASS=<password>` to `.env.secret.app`, then:

   ```bash
   ./scripts/encrypt-env-files.sh apps/production/job-accelerator
   ```

5. Push both groups to 1Password and commit the `.encrypted` files:

   ```bash
   ./scripts/onepassword-secrets.mts push --only email-relay --only job-accelerator
   ```

## Rotation

### Relay password (`SMTP_PASS` / `SMTPD_SASL_USERS`)

Generate a new value with `openssl rand -hex 32` and set it in both places at once:
`SMTP_PASS` here and this app's entry in email-relay's `SMTPD_SASL_USERS`. They must
always match, or the app loses its ability to send mail.

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

Then update `POSTGRES_PASSWORD` and the password embedded in `DATABASE_URL` to match,
and re-encrypt.

## Sending mail

`pingpoet.com` must be onboarded to Cloudflare Email Sending before the relay can send as
`noreply@pingpoet.com`.

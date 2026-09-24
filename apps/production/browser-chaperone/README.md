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
by the app, the browser service and the Slack relay.

`.env.secret.slack-relay` (Secret `slack-relay-creds`): `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`RELAY_BOT_TOKEN`, `RELAY_APP_TOKEN`. The committed file holds placeholders; see below.

## Relay password

The app will not start in production without `SMTP_PASS`, and the relay's SASL users are
not set by an agent (`apps/production/email-relay/README.md`):

1. Generate a password: `openssl rand -hex 32`.
2. Append `,browserchaperone@relay.local:<password>` to `SMTPD_SASL_USERS`:
   `./scripts/onepassword-secrets.mts edit apps/production/email-relay/.env.secret.relay`
3. Add `SMTP_PASS=<password>`:
   `./scripts/onepassword-secrets.mts edit apps/production/browser-chaperone/.env.secret.app-signin`
4. Commit both `.encrypted` files.

## Slack relay tokens

Four values, in two files, and none of them exists yet
(`activescott/activeassistant#312`). Until they do, the relay's Secret holds placeholders and
olya-0 has no `relay_bot_token` to start with, so the change that adds them is what makes
both pods work. Olya holds the two `RELAY_*` credentials and no Slack token at all; that is
the whole point of the relay, so do not shortcut step 4 by copying a Slack token there.

1. Rotate the bot token by reinstalling the app in the workspace (Slack app settings, Install
   App, Reinstall). The old `xoxb-` token was in olya-0's environment, and Slack does not
   expire it: without the reinstall she can keep posting around the relay with it.
2. Generate the two relay credentials, one for each: `openssl rand -hex 32`. The relay refuses
   to start if they match each other or if either is one of the real Slack tokens.
3. Replace all four placeholders in the relay's Secret:
   `./scripts/onepassword-secrets.mts edit apps/production/browser-chaperone/.env.secret.slack-relay`
   `SLACK_BOT_TOKEN` is the new bot token from step 1, `SLACK_APP_TOKEN` the App-Level Token
   with `connections:write`, and `RELAY_BOT_TOKEN` and `RELAY_APP_TOKEN` the two from step 2.
4. Add the same two credentials to olya's Secret, as `relay_bot_token` and `relay_app_token`:
   `./scripts/onepassword-secrets.mts edit apps/production/olya/.env.secret.olya`
   These are what `channels.slack` in `openclaw.json` reads as `SLACK_BOT_TOKEN` and
   `SLACK_APP_TOKEN`. A value that does not match the relay's copy gets Slack's own
   `invalid_auth` on every call, with nothing else to say what went wrong.
5. Commit both `.encrypted` files and merge. That rolls olya-0.

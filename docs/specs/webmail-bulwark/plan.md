# Phase 8 — webmail on mail.activescott.com

Browser access to the Stalwart mailboxes, so a mailbox is usable without installing a
configuration profile. Last phase of the email-infrastructure work; state and history in
`home-infra-private/docs/specs/email-infrastructure/summary.md`.

## Client choice

`bulwarkmail/webmail` — "Bulwark", a JMAP-native webmail built specifically for Stalwart.

| | |
|---|---|
| Repo | `bulwarkmail/webmail`, 1093 stars, 162 forks |
| License | **AGPL-3.0-only** (GitHub reports `NOASSERTION`; the file itself states AGPL v3 *only*) |
| Created | 2026-03-13 — **five months old** |
| Latest | `1.9.2`, 2026-08-26; releases roughly weekly since May |
| Activity | pushed 2026-08-29; 143 open issues |
| Image | `ghcr.io/bulwarkmail/webmail:1.9.2`, multi-arch (amd64 + arm64) |
| Digest | `sha256:0e8d1339277033b6569a76c6f8192396e6edd66fd917d64d9ed505e8b81dac6d` |
| Stack | Next.js, no database, four state directories |

Alternatives considered:

- `root-fr/jmap-webmail` — MIT, 220 stars, older (Dec 2025). Viable fallback, smaller feature
  set, no calendar/contacts/files.
- Roundcube / SnappyMail over IMAP — mature, but IMAP-only, so no CalDAV/CardDAV integration
  and none of the Stalwart-native features (password change, Sieve editing).
- Stalwart's own webmail — announced for after their 1.0, "most likely sometime in 2026". Not
  a thing that can be deployed today.

**The age is the real risk.** This is a five-month-old AGPL project that will be internet-facing
and will hold every mailbox session. That argues for pinning by digest, keeping it off the
admin surface, and treating an upgrade as a deliberate act rather than `:latest`.

## How it talks to Stalwart, and why that decides the hostname

**The browser speaks JMAP to Stalwart directly.** There is no server-side JMAP proxy: the app's
API routes are `account, admin, auth, caldav, calendar-agenda, config, dev-jmap, fetch-ical,
health, ..., webdav` — no `jmap` route — and the README states plainly that external JMAP
servers "must CORS-allow the webmail origin".

That makes the hostname a security decision rather than a cosmetic one:

- **Same origin** (Bulwark at `/` on `mail.activescott.com`): the JMAP calls are same-origin, so
  **no CORS configuration exists to get wrong**.
- **Separate host** (`webmail.activescott.com`): every JMAP call becomes cross-origin, requiring
  `Access-Control-Allow-Origin` on Stalwart plus a second certificate.

Either way `/jmap` becomes publicly reachable, which it is not today. It is authenticated, and
`/dav` is already exposed on the same terms, so this is a widening of an existing surface rather
than a new class of one.

Verified against the running server (in-cluster, 2026-08-30):

```
/.well-known/jmap   307 -> /jmap/session
/jmap/ws            401
/jmap/eventsource   401
/jmap/download      401
```

So routing needs exactly two additions: the `/jmap` prefix and the `/.well-known/jmap` exact
path.

### Resulting routing on mail.activescott.com

Traefik ranks routers by rule specificity, so the existing narrow rules keep winning over
Bulwark's `/`:

| Path | Backend | Status |
|---|---|---|
| `/setup`, `/setup/...` | `mail-setup` nginx | existing |
| `/robots.txt` | `mail-setup` nginx | existing |
| `/dav`, `/.well-known/caldav`, `/.well-known/carddav` | Stalwart | existing |
| `/jmap`, `/.well-known/jmap` | Stalwart | **new** |
| `/` (everything else) | Bulwark | **new** |

Bulwark owns the root, which includes `/api/...`, `/_next/...` and `/sw.js`. Nothing in
Stalwart's or nginx's path set collides today; a future Stalwart path could, so new Stalwart
routes must be added as explicit rules rather than assumed.

## Configuration: env, not the setup wizard

Bulwark ships a first-launch setup wizard that writes `config.json`, `policy.json` and
`admin.json` (carrying a password hash) into a volume. That is click-ops, and the whole point of
`stalwart-config-as-code` was to stop configuration living somewhere git cannot see.

The README states an environment variable always wins over the admin-managed value and hides the
corresponding field from the wizard. So: drive everything reachable from env, and set
`ADMIN_CONFIG_READONLY=true`.

Known env surface (from `.env.example`):

- `JMAP_SERVER_URL` — `https://mail.activescott.com`
- `STALWART_FEATURES=true` — password change, Sieve filter editing
- `SESSION_SECRET_FILE` — encrypts "remember me" sessions and synced settings; SOPS
- `SETTINGS_SYNC_ENABLED` — server-side per-user settings, requires the secret above
- `ADMIN_CONFIG_READONLY=true`, `ADMIN_PASSWORD` / wizard-set hash
- `TRUSTED_PROXY_DEPTH` — client-IP derivation behind Traefik
- **Telemetry is opt-in and off by default.** `BULWARK_TELEMETRY` stays unset; no action beyond
  not enabling it, and no telemetry volume is needed.

## Storage

Three volumes matter (telemetry dropped, per above):

- `SETTINGS_DATA_DIR` — encrypted per-user settings. Real user data; belongs on
  `/mnt/thedatapool/app-data/`, inside the B2 include list.
- `ADMIN_CONFIG_DIR` — mounted read-only once configuration is in git.
- `ADMIN_STATE_DIR` — login timestamps, audit log, setup token. Must stay writable.

Losing the settings volume costs preferences, not mail: mail lives in Stalwart. So this is not
a durability-critical store, but it should still land in the backed-up tree rather than
`no-backup/`.

Note the offsite backup is currently **failing at the tail** (last run Mon 2026-08-24, partial,
`not deleting files as there were IO errors`) and syncs live files rather than a ZFS snapshot.
Tracked separately as #31; it is not a blocker for this phase but it is the reason not to treat
"it's on thedatapool" as equivalent to "it's backed up".

## Decisions (settled 2026-08-30)

1. **Login is OAuth/OIDC against Stalwart**, not JMAP basic auth. Accounts here use 2FA and basic
   auth cannot carry a second factor, which is why mail clients use app passwords; OAuth means no
   app password ever enters a browser session.
2. **Bulwark owns `/` on `mail.activescott.com`.** Same origin, so no CORS exists to get wrong.

## Stalwart is already a full OIDC provider

Verified in-cluster against the running 0.16.19 (2026-08-30). Discovery answers at both
`/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`:

- `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`
- `token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"]`
- `grant_types_supported`: authorization code, refresh token, device code
- `scopes_supported`: `openid`, `offline_access`, and `urn:ietf:params:oauth:scope:` `mail`,
  `contacts`, `calendars`

`"none"` plus PKCE `S256` means Bulwark can be a **public client with no client secret** — one
fewer secret to hold, rotate and leak.

And the client itself is declarable. `OAuthClient` is a first-class config object
(`clientId`, `redirectUris`, optional `secret`, `description`, `contacts`), so it goes in
`plan.ndjson` alongside everything else rather than being clicked into the admin UI.

## Two things must change in Stalwart before this can work

Both were found by probing rather than reading, and neither is optional.

### 1. Discovery advertises the wrong issuer

```json
{"issuer":"https://stalwart-0","authorization_endpoint":"https://stalwart-0/login", ...}
```

`stalwart-0` is the StatefulSet pod hostname. Every endpoint in the document is unreachable from
a browser, so the OAuth flow cannot start. **It does not follow the `Host` header** — sending
`Host: mail.activescott.com` and `X-Forwarded-Proto: https` returns the same document, so
`useXForwarded` does not help here.

The cause is configuration, not a bug: `SystemSettings.defaultHostname` is `""`, so Stalwart
falls back to the OS hostname. `SystemSettings.services.jmap.hostname` is also `null`, and it is
the more targeted knob — setting `defaultHostname` also changes SMTP greetings, MTA reports and
`Received:` headers.

Try the per-service hostname first, re-read the discovery document, and only fall back to
`defaultHostname` if that does not move it. Setting `defaultHostname` is defensible either way
(`stalwart-0` is a poor EHLO name), but it is a change to the mail path and should not be made
accidentally while chasing a webmail problem.

### 2. Anyone could register an OAuth client

```json
{"anonymousClientRegistration": true, "requireClientRegistration": false}
```

Today this is harmless because **no OIDC endpoint is routed publicly** — the Ingress carries only
`/setup`, `/robots.txt`, `/dav` and the two DAV `.well-known` paths. This phase changes that.

With the defaults as they stand, exposing OIDC would let anyone on the internet register a client
at `/auth/register`, or skip registration entirely and drive an authorization flow with any
`client_id` they invent, against real users at a real login page. Before any OIDC path is
exposed, `plan.ndjson` must set:

- `anonymousClientRegistration: false`
- `requireClientRegistration: true`

and declare the one `OAuthClient` that is allowed. **Sequence this ahead of the Ingress change,
in a separate apply, and confirm it took effect** — configuration is built at startup, so it
means a restart and a re-check, not just an apply.

## Routing, revised for OAuth

The OIDC flow is browser-driven, so its endpoints need public routes too:

| Path | Backend |
|---|---|
| `/jmap`, `/.well-known/jmap` | Stalwart |
| `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server` | Stalwart |
| `/login` (authorization endpoint) | Stalwart |
| `/auth/token`, `/auth/userinfo`, `/auth/jwks.json` | Stalwart |
| `/setup`, `/robots.txt` | `mail-setup` nginx (existing) |
| `/dav`, `/.well-known/caldav`, `/.well-known/carddav` | Stalwart (existing) |
| `/` (everything else) | Bulwark |

Deliberately **not** routed: `/auth/register` (dynamic client registration — we declare our
client in git) and `/auth/device` (device flow, unused here). Leaving them unrouted is a second
layer behind the `requireClientRegistration` setting above.

Note `Http.redirectRoot` is `/account`, Stalwart's own root redirect. Harmless, because Traefik
gives `/` to Bulwark and Stalwart never sees it.

Watch `Http.rateLimitAnonymous` (100 per 60s) and `rateLimitAuthenticated` (1000 per 60s).
Webmail is far chattier than DAV, and with `useXForwarded: true` these count per real client IP,
so they should hold — but this is the first workload that could reach them.

## Steps

Ordered so the security-relevant change lands and is proven *before* anything is exposed.

1. Save this plan (done).
2. **Stalwart config first**, in `plan.ndjson`: flip `anonymousClientRegistration` to false and
   `requireClientRegistration` to true, set the JMAP service hostname, and declare the
   `OAuthClient` (clientId, `redirectUris`, no secret). Apply, **restart**, then re-read the
   discovery document and confirm the issuer is `https://mail.activescott.com`. This step is
   independently verifiable and touches nothing user-facing.
3. Namespace `email-webmail`, PV/PVC on `/mnt/thedatapool/app-data/bulwark/`.
4. `env.secret.bulwark.example` template committed with `<REPLACE-ME>`; Scott fills the real
   `.env.secret.bulwark` and runs `./scripts/encrypt-env-files.sh`. The agent never reads it.
   Contents: `SESSION_SECRET` only — with a public OAuth client there is no client secret.
5. Deployment pinned to the digest above, non-root, `readOnlyRootFilesystem` where Next.js
   allows, resource limits, health probe on `/api/health`. Env sets `OAUTH_ENABLED=true`,
   `OAUTH_ONLY=true` (no password form at all), `OAUTH_ISSUER_URL`, `OAUTH_CLIENT_ID`,
   `JMAP_SERVER_URL`, `STALWART_FEATURES=true`, `ADMIN_CONFIG_READONLY=true`,
   `TRUSTED_PROXY_DEPTH`.
6. Ingress: add the Stalwart OIDC/JMAP paths, then `/` to Bulwark.
7. NetworkPolicy: Bulwark egress to Stalwart only; ingress from Traefik only.
8. Verify (below), then monitoring — a probe and an alert in the existing `email-stalwart`
   Grafana group.

## Verification

- `/setup`, `/dav`, `/.well-known/caldav` still resolve to their current backends — Traefik
  specificity is the assumption this phase rests on, so prove it rather than assume it.
- The discovery document served publicly names `https://mail.activescott.com` in **every**
  endpoint, not just `issuer`.
- `/auth/register` is **not** reachable from the internet, and a flow using an unregistered
  `client_id` is refused. Test both — the setting and the route are independent defences and
  either could be wrong on its own.
- Log in with the real account password **and 2FA**, confirming no app password is involved.
- Log in as `scott@willeke.com`, read a message, send one, confirm it lands in Archive as well
  as Sent behaviour matches the Sieve script's coverage (Sent is **not** archived — `APPEND` has
  no Sieve path).
- Calendar and contacts load, against the same CalDAV/CardDAV the phone profile uses.
- Confirm no `Access-Control-Allow-Origin` is needed, i.e. every JMAP request is same-origin.
- Confirm the admin dashboard is not reachable without the admin password, and that
  `ADMIN_CONFIG_READONLY` is in force.
- Stalwart does not ban the Traefik pod IP under webmail load — the *Obtain remote IP from
  Forwarded header* setting plus the allow-listed pod CIDR already exist for this reason, and
  webmail generates far more requests than DAV did.

## Rollback

Delete the `/` Ingress rule; `/setup`, `/dav` and the phone profiles are untouched by everything
here. Removing the `/jmap` rule closes the newly-exposed surface. Nothing in this phase writes
to the Stalwart store.

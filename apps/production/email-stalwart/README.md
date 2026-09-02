# email-stalwart — self-hosted mailboxes for willeke.com

## What this is

Receives a **copy** of mail for `scott@willeke.com` and serves it over IMAP, plus CalDAV/CardDAV
and outbound submission for Scott's own clients. Google Workspace stays the authoritative MX and
keeps its own copy of every message; this server is additive and never load-bearing for account
recovery. That is the whole safety argument for Phase 7 — see
`docs/specs/email-infrastructure/spec.md` in the private repo.

This is the _inbound personal mail_ path. It is unrelated to `email-relay/`, which is the
_outbound application_ path — deliberately separate services so a mistake in one cannot affect
the other.

Deployed 2026-08-28, listed in `apps/production/kustomization.yaml`, live. `willeke.com` is a
shared domain (Scott's father also uses it), which is why nothing here writes DNS and why the
hostname is `mail.activescott.com` rather than something under `willeke.com` — see Gotchas.

## Runbook

### First run on a fresh server

`hostPath` volumes are not chowned by the kubelet, and the image runs as uid/gid 2000. Create and
own the directories **before** the pod starts, or Stalwart drops into bootstrap mode looking
exactly like data loss:

```bash
ssh nas 'sudo mkdir -p /mnt/thedatapool/app-data/stalwart/prod/{config,data} \
  && sudo chown -R 2000:2000 /mnt/thedatapool/app-data/stalwart'
```

Both paths sit under `/app-data/`, already on the B2 cloud sync include list — no backup config
changes needed.

The pod starts in bootstrap mode and opens `:8080` for setup, with no ingress for it:

```bash
kubectl --context nas -n email-stalwart port-forward svc/stalwart-admin 8080:8080
# then open http://127.0.0.1:8080/admin
```

Log in with the `STALWART_RECOVERY_ADMIN` pair from the secret, not the one-time password printed
to stdout — pinning it is the reason that variable is set. The admin web UI is **downloaded at
runtime** from `https://github.com/stalwartlabs/webui/releases/latest/download/webui.zip`, so the
pod needs egress to GitHub to be administrable, and it tracks `latest` rather than the image tag.

Then: register the TLS certificate (next section), do the one-time Google Workspace click-ops
(dual-delivery routing rule + SMTP relay settings, both below), and apply
`stalwart-config/plan.ndjson` — see that directory's own README for the config-as-code workflow.
The Google Workspace dual-delivery routing rule is what makes inbound mail actually arrive;
everything else is inert without it. Its settings are click-ops in Google's console, recorded in
the private repo at `docs/specs/email-infrastructure/google-workspace-routing.md`.

### Registering the TLS certificate

cert-manager issues it over HTTP-01, exactly like every other hostname in this cluster — Stalwart
only ever reads the finished certificate from disk, and does not need to answer on `:80` itself
for this to work. `stalwart-certificate.yaml` declares it; the Secret `stalwart-tls` is mounted
read-only at `/etc/stalwart-tls`.

Stalwart will not **use** the certificate until a `Certificate` object in its own database points
at the mounted files — not in git, must be recreated by hand after any rebuild:

**Settings → TLS → Certificates → Create**, both as **File** references:

| Field       | Value                       |
| ----------- | --------------------------- |
| Certificate | `/etc/stalwart-tls/tls.crt` |
| Private key | `/etc/stalwart-tls/tls.key` |

Use File references, never pasted PEM text — pasted text is a copy frozen in the database that
would not follow cert-manager's renewals. **After saving, restart the pod** (see "After changing
any MTA/TLS/metrics setting" below) — see Troubleshooting for why this step is easy to skip and
hard to notice you skipped.

DKIM is not configured here, because Stalwart signs nothing — see Configuring the outbound relay.
Stalwart also reports that its resolver cannot validate DNSSEC and therefore disables DANE, which
is fine for a receive-only role but forecloses TLSA if this ever becomes authoritative.

### Onboarding a mail client — send people to `/setup`

**<https://mail.activescott.com/setup>**

That page has the whole procedure: create an app password, install the configuration profile, and
the manual host/port table for anything that is not Apple Mail. Hand out the URL; nothing else
needs explaining, and nothing about it is per-user.

The page asks for the user's address and builds a link to
`/setup/profiles/<address>/apple.mobileconfig`, the same profile with the address substituted into
all five places it appears — sets up **mail, calendar and contacts** in one install.
`/setup/apple.mobileconfig` is the fallback for anyone who does not enter an address: mail only,
with Apple prompting for the identity. `/robots.txt` disallows everything, since the profile URLs
carry an email address.

Each user creates their own app password under **Account → App Passwords** in the Stalwart UI —
2FA is enabled on these accounts, and IMAP/SMTP cannot do a two-factor login, so plain
`AUTH PLAIN`/`LOGIN` with the sign-in password fails. It acts on the logged-in user and requires
re-entering their password, so it is self-service with no admin involvement.

**Why a configuration profile at all:** Apple Mail cannot be pointed at this server by hand on
iOS. The New Account screen shows no port fields and will not save the account until both servers
verify, so there is no way to reach the screen where the ports could be corrected. Verification
fails because iOS probes submission on 587, gets refused, then falls back to **25** — the MTA
listener, which advertises no `AUTH` — and Mail reports **"incorrect username or password"**,
which is false: the server log shows no failed authentication, because none was attempted. A
`.mobileconfig` sidesteps the probe by stating the ports as fact.

**Two profiles, and why:**

| Path                                           | Payloads                | Identity                     |
| ----------------------------------------------- | ------------------------ | ----------------------------- |
| `/setup/apple.mobileconfig`                    | mail only               | none — Apple prompts for it  |
| `/setup/profiles/<address>/apple.mobileconfig` | mail + CalDAV + CardDAV | address substituted by nginx |

The mail-only one carries no DAV payloads deliberately: `CalDAVUsername`/`CardDAVUsername` are
documented as _required_ rather than prompted, so a DAV payload without one may fail to install
rather than ask. Neither profile carries a password (Apple restricts password keys to encrypted
profiles, and both are served in the clear) — costs three password prompts on the templated
profile, all taking the same app password.

**Calendar and contacts:** IMAP carries mail only — Calendar needs CalDAV/CardDAV over HTTPS,
which Stalwart serves on its HTTP listener. The Ingress routes `/dav` plus
`/.well-known/caldav`/`/.well-known/carddav` on this hostname to `stalwart-admin:8080`; Apple
discovers the endpoints via the well-known paths (verified 2026-08-28: 307 to `/dav/cal` and
`/dav/card`). The profiles set no `CalDAVPrincipalURL`/`CardDAVPrincipalURL` and rely on that
discovery — if it ever breaks, add `/dav/cal/` and `/dav/card/` explicitly. Only those paths are
routed here, so the admin UI stays reachable solely at `admin.mail.activescott.com`.

**Changing the page or the profiles:** everything lives in `mail-setup/`, a self-contained
kustomization. Kustomize hashes the content files into the ConfigMap names, so editing the page or
either profile rolls the `mail-setup` Deployment on the next reconcile — do not convert them to
inline ConfigMaps, or content would change under a running pod without restarting it. **Keep the
two profiles in sync** — they share a mail payload, so a port or hostname change has to land in
both.

The Ingress routes four things on this hostname, and nothing at `/`:

| Path                   | Type   | Backend          |
| ---------------------- | ------ | ---------------- |
| `/setup`               | Prefix | `mail-setup`     |
| `/robots.txt`          | Exact  | `mail-setup`     |
| `/dav`                 | Prefix | `stalwart-admin` |
| `/.well-known/car*dav` | Exact  | `stalwart-admin` |

That shape is what lets Bulwark webmail take `/` on this same hostname: Traefik ranks routers by
rule specificity, so all four beat `PathPrefix(/)`.

### Configuring the outbound relay

Stalwart delivers **nothing** directly — outbound `:25` is blocked by Ziply (Phase 0e) — so it
relays through Google Workspace's **SMTP relay service**, `smtp-relay.gmail.com:587` over
STARTTLS, authenticated with a Google app password. This keeps `willeke.com`'s DNS untouched:
Google remains the entity that sends, so the existing `v=spf1 include:aspmx.googlemail.com ~all`
still passes and no SPF/MX/DMARC/DKIM change is needed — important since that SPF record is
domain-wide on a domain shared with Scott's father. Sending through Stalwart also populates its
Sent folder, so the archive covers outbound without a second Google routing rule.

One-time Google Admin console setup (Apps → Google Workspace → Gmail → Routing → **SMTP relay
service**; requires _Gmail Settings_ admin privilege, org-wide only, up to 24h to apply):

| Setting                                          | Value                        |
| ------------------------------------------------- | ---------------------------- |
| Allowed senders                                  | Only addresses in my domains |
| Only accept mail from the specified IP addresses | unchecked                    |
| Require SMTP Authentication                      | checked                      |
| Require TLS encryption                           | checked                      |

The IP-allowlist option is unusable here — residential DHCP with a 30-minute lease, changed twice
in August 2026 — and there is no service-account/OAuth alternative: XOAUTH2 cannot be domain-level
by construction, since its SASL response carries a named `user=` address. Port 587 with STARTTLS
rather than 465, per Google's own documentation (465 is only mentioned under "not using TLS
encryption," which also states TLS is required for SMTP auth at all).

Server-side, two objects in `stalwart-config/plan.ndjson` (git, not click-ops):

**`MtaRoute`** of type `Relay`:

| Property       | Value                                                 |
| -------------- | ------------------------------------------------------ |
| `name`         | `google-willeke-com-relay`                            |
| `address`      | `smtp-relay.gmail.com`                                |
| `port`         | `587`                                                 |
| `protocol`     | `smtp`                                                |
| `implicitTls`  | false (so STARTTLS is used)                           |
| `authUsername` | the Google account holding the app password           |
| `authSecret`   | `EnvironmentVariable` → `STALWART_SMARTHOST_PASSWORD` |

`authSecret` resolves **once at configuration-build time** — a rotated Secret needs a pod restart,
and a value it cannot resolve silently degrades the route to _unauthenticated_ relay rather than
erroring.

**`MtaOutboundStrategy`**, currently:

```json
{
  "route": {
    "match": { "0": { "if": "is_local_domain(rcpt_domain) && key_exists('willeke-local-mailboxes', to_lowercase(rcpt))", "then": "'local'" } },
    "else": "'google-willeke-com-relay'"
  },
  "schedule": {
    "match": {
      "0": { "if": "is_local_domain(rcpt_domain) && key_exists('willeke-local-mailboxes', to_lowercase(rcpt))", "then": "'local'" },
      "1": { "if": "source == 'dsn'", "then": "'dsn'" },
      "2": { "if": "source == 'report'", "then": "'report'" }
    },
    "else": "'remote'"
  }
}
```

Both fields' stock condition was `is_local_domain(rcpt_domain)` alone, which routes **every**
`@willeke.com` address to `'local'` — the whole domain is local, not just `scott@willeke.com`.
Both now also check `willeke-local-mailboxes` (a `MemoryLookupKey` list — see
`stalwart-config/README.md`'s "Split-delivery relay" section), so `'local'` only fires for
addresses that are real mailboxes here; every other `@willeke.com` address goes out through the
smarthost like any other domain. See Troubleshooting for why **both** fields needed the fix, not
just one, and Gotchas for the `match` JSON encoding trap.

Why `smtp-relay.gmail.com` and not `smtp.gmail.com`: the latter is _submission_, and Google
rewrites `From:` to the authenticated account unless the address is a verified "Send mail as"
alias — exactly the bug this project started from (`activescott/fernfiles#204`). The relay service
instead governs the From address at the **domain** level (Google: "Addresses in the From: and
Reply-to: fields are ignored"), so any address at `willeke.com` can send without a matching
Google-side user, and the 10,000/day quota is charged to the envelope sender, not the
authenticating account.

### Enabling the Prometheus exporter

Off by default, and **not** restored by redeploying this repo — it lives in Stalwart's datastore:

1. Admin UI → **Settings › Telemetry › Metrics › Prometheus**
2. **Enabled**, `authUsername` = `prometheus`
3. `authSecret` → **Environment variable** → `STALWART_METRICS_PASSWORD`
4. Restart the pod (see below) — the endpoint returns 404 until it does.

`/metrics/prometheus` is served on the **same HTTP listener as the admin UI**, published to the
internet with no way to bind it separately, so authentication is not optional here.
`stalwart-metrics-ingress.yaml` blocks the path at the edge as an independent second layer,
because the datastore auth setting and the git-managed ingress rule each cover the other's blind
spot — see Gotchas for the failure direction that makes this matter.

The password lives in **two files that must hold the same value**, different namespaces:

| File                                                                 | Key                         | Read by    |
| ---------------------------------------------------------------------- | ---------------------------- | ---------- |
| `apps/production/email-stalwart/.env.secret.stalwart`                | `STALWART_METRICS_PASSWORD` | Stalwart   |
| `apps/production/monitoring/prometheus/.env.secret.stalwart-metrics` | `stalwart_metrics_password` | Prometheus |

### After changing any MTA/TLS/metrics setting: restart

**Saving a setting in the admin UI is not the same as the running server using it.** Stalwart
builds its configuration at startup; applying does not restart it.

```bash
kubectl --context nas -n email-stalwart rollout restart statefulset/stalwart
```

Change the setting, restart, _then_ test — testing between those two steps produces a result about
the old configuration and reads exactly like the change not working. This has cost real time more
than once; see Troubleshooting for the specific ways it bit.

## Troubleshooting

### Locked out of the admin UI / DAV (auto-ban)

Symptom: `admin.mail.activescott.com` and `/dav/*` return 502, `/setup` still works (separate
nginx). Cause: both HTTP hostnames reach `:8080` through Traefik, so without configuration every
request looks like it came from Traefik's pod IP — Stalwart's auto-ban then counts the whole
internet's behavior against one address and bans the ingress controller. Happened 2026-08-29: 430
`security.ip-blocked` events in 24h against `172.16.2.88`, almost certainly `scanBanRate` (30
hits/day against `*/wp-*`, `*.php*`, `*xmlrpc*`, … — background internet noise against a public
admin UI). A DAV client's initial 401 is _not_ an auth failure and does not count.

Fixed by two click-ops settings (2026-08-29):

| Where                                          | Setting                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Settings › Network › Services › HTTP › General | Proxy → **Obtain remote IP from Forwarded header** = on (`useXForwarded`) |
| Settings › Security › Allowed IPs              | `172.16.0.0/16`, reason "cluster pod CIDR (Traefik ingress)"              |

`useXForwarded` is the actual fix — safe here only because k3s's Traefik sets no
`forwardedHeaders.trustedIPs` and therefore **strips** any client-supplied `X-Forwarded-For`
before adding its own. Re-check this if Traefik's args change, or a trusting proxy would make bans
trivially evadable. The allow-list entry is what recovers a **live** outage: `is_ip_blocked()` ends
in `&& !is_ip_allowed(ip)`, so an allow-listed address is un-blockable and un-bannable immediately,
even against an existing block record.

If it does get banned, the way back in bypasses Traefik and arrives as loopback — always allowed:

```bash
kubectl --context nas -n email-stalwart port-forward stalwart-0 8081:8080
```

### Mail not delivering after a routing/strategy change

Two independent causes, both hit in practice:

1. **The pod wasn't restarted.** See "After changing any MTA/TLS/metrics setting" above. A message
   submitted ~30 seconds after saving an outbound strategy change still went to direct MX and
   timed out — the configuration in force had been built before the save.
2. **Only `route` was fixed, not `schedule`.** `MtaOutboundStrategy.route` picks the next hop
   _within_ whichever queue a message is already in; `MtaOutboundStrategy.schedule` is what
   buckets it into `'local'` vs `'remote'` (plus `'dsn'`/`'report'`) in the first place, and is
   consulted **first**. Fixing `route` alone (2026-08-31) still let `schedule` file
   `willeke.com`-sibling addresses into local delivery, which bounced with a DSN back to the
   sender instead of relaying. Confirmed from the queue log by which field's vocabulary appeared —
   `queueName = "local"` vs `"remote"` is `schedule`'s output, never `route`'s (`route`'s else-value
   is a named route like `google-willeke-com-relay`, not the literal string `"remote"`). Check
   `queueName` in the delivery log before assuming a `route` change was sufficient.

A route `name` that does not resolve to an `MtaRoute` object is not an error — delivery silently
falls back to direct MX and expires, which looks identical to no change having been made at all.
Confirm from the queue log that a delivery attempt actually names `smtp-relay.gmail.com`.

### TLS being served is stale despite the admin UI looking correct

Observed 2026-08-28: after saving a `Certificate` object, the admin UI displayed it and its domain
correctly (it reads the file at save time to extract SANs), while the server kept logging
`WARN No TLS certificates available (tls.no-certificates-available) total = 0` and served its
self-signed placeholder on every port. A pod restart fixed it at once — the documented
`ReloadTlsCertificates` action is not present in this version's UI at all. **A correct-looking
admin UI is not evidence TLS is being served.** Always check the wire:

```bash
openssl s_client -connect 10.1.111.20:993 -servername mail.activescott.com </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates
```

The same failure mode applies to certificate **renewal**, silently, for up to ~60 days: cert-manager
renews, the kubelet refreshes the mounted Secret, and the running server keeps serving the old
certificate. cert-manager's own metric goes green at the moment of renewal and stays green the
whole time — it cannot see this. `StalwartServedCertNotRenewed` compares the served certificate
against cert-manager's directly and fires on the gap, roughly a day after a renewal that didn't
reload and ~30 days before anything actually breaks; the **Reload lag** Grafana panel shows the
same quantity continuously (flat at zero is correct). The other two certificate alerts,
`StalwartServedCertExpiringSoon` and `StalwartCertificateNotRenewing`, are the obvious pair — what's
on the wire, and what cert-manager holds — and neither catches this specific failure.

### Metrics endpoint returns 404, or returns 401

- **404** — the Prometheus exporter is off in the datastore setting (see "Enabling the Prometheus
  exporter"), or the pod hasn't been restarted since it was turned on.
- **401** — `StalwartMetricsScrapeDown` fires either way, so check the status code before assuming
  which: 401 means the password in `.env.secret.stalwart` and
  `monitoring/prometheus/.env.secret.stalwart-metrics` have drifted apart (two files, two
  namespaces, must hold the same value).
- **A 401 in the first minute or two after a rotation is expected, not drift.** The two sides pick
  the new value up by different mechanisms: `stalwart-creds` is name-suffix-hashed, so a new value
  renames the Secret, changes the StatefulSet pod template and restarts the pod (needed anyway —
  Stalwart resolves `authSecret` once at config-build time); `stalwart-metrics-auth` sets
  `disableNameSuffixHash`, so it is updated in place and Prometheus keeps serving the old mounted
  value until the kubelet syncs the projected volume. Measured on the 2026-09-01 rotation: both
  Secrets written at 23:58:50, new pod up at 23:58:52, scrapes at 23:59:12 and 23:59:42 returned
  401, first 200 at 00:00:12 — about 80 seconds. Prometheus re-reads `password_file` on every
  scrape, so it never needs a restart of its own.
- **Do not read recovery off the scrape target's `health` field.** It reports the last *completed*
  scrape, so immediately after the restart it still shows the pre-restart `up` while the endpoint
  is 401ing. Compare `lastScrape` against the pod's `startTime`:

  ```bash
  kubectl --context nas -n email-stalwart get pod stalwart-0 -o jsonpath='{.status.startTime}{"\n"}'
  kubectl --context nas -n monitoring exec deploy/prometheus-server -c prometheus-server -- \
    wget -qO- 'http://localhost:9090/api/v1/targets?state=active' \
    | jq -r '.data.activeTargets[]|select(.labels.job=="stalwart")|"\(.health) \(.lastScrape) \(.lastError)"'
  ```

- To tell a genuine drift from a slow mount **without decrypting either file**, hash both sides
  where they are consumed and compare the truncated digests. Neither command prints the value:

  ```bash
  kubectl --context nas -n email-stalwart exec stalwart-0 -- \
    sh -c 'printf %s "$STALWART_METRICS_PASSWORD" | sha256sum | cut -c1-12'
  kubectl --context nas -n monitoring exec deploy/prometheus-server -c prometheus-server -- \
    sh -c "tr -d ' \t\n\r' < /etc/prometheus/secrets/stalwart_metrics_password | sha256sum | cut -c1-12"
  ```

  Equal digests with a persistent 401 means the problem is not the password. Unequal means the two
  files really did drift — see `env.secret.stalwart.example` for how to rotate them together.
- If Stalwart cannot resolve `STALWART_METRICS_PASSWORD` at all, it degrades the endpoint to
  **unauthenticated** rather than failing loudly — the dangerous direction, and the whole reason
  `stalwart-metrics-ingress.yaml` blocks the path at the edge as a second, git-managed layer
  independent of the datastore setting.

### Dashboard panels went blank after an Alloy config change

Editing `monitoring/alloy/helmrelease.yaml` and letting the config-reloader sidecar hot-reload is
not enough: a reload re-registers `loki.process` counters without unregistering the old ones, and
the Prometheus client library then refuses to serve `/metrics` **at all**:

```
collected metric "loki_process_custom_email_relay_sent_total" {...}
was collected before with the same name and label values
```

The scrape fails and **every** Alloy-derived series disappears, not just the edited ones —
observed 2026-08-29, when the email-relay, WAN-flapping and tinkerbell log-health alerts all went
blind together with no symptom beyond alerts quietly not firing. Fix:

```bash
kubectl --context nas -n monitoring rollout restart daemonset alloy
```

This is why every alert reading these counters carries an `or absent(...)` arm — a bare `== 0`
cannot fire on a series that doesn't exist, which is exactly the state this bug produces.

### A metrics panel reads "No data" on an otherwise-healthy server

Expected on a freshly restarted, idle server: Stalwart exports a counter only once its event has
occurred since the process started. Verified 2026-08-29 — `message_ingest_ham`, `smtp_dkim_pass`,
`smtp_dmarc_pass` and `queue_message_queued` were all absent until a test message arrived, then
read `1`. Always-present gauges, useful as proof the exporter itself is working, are `user_count`,
`domain_count`, `server_memory` and the `*_active_connections` family. `queue_count` exists only
while the queue is non-empty — `StalwartQueueBacklog` is unaffected, but any panel reading it
needs `or vector(0)`.

To generate real end-to-end traffic (relay → Cloudflare → Google MX → dual delivery → Stalwart
`:25`):

```bash
./apps/production/email-relay/send-test-email.sh --send-only scott@willeke.com
```

Use `--send-only` — the default mode deliberately fails an authentication to prove the relay's
access controls hold, which trips `EmailRelayAuthFailures`.

## Gotchas

- **Configuration lives in Stalwart's own datastore, not git.** Since v0.16 there is no TOML
  config and no `config apply` command — the entire CLI is `--config`, `--export`, `--import`,
  `--console`, and the old REST admin API was removed. `stalwart-data` is the only copy of the
  configuration as well as the mail; restoring this service means restoring that volume. Most of
  it is now covered by `stalwart-config/plan.ndjson` (see that directory's README), but anything
  not yet in the plan is a **recorded exception** to this repo's git-as-source-of-truth rule —
  keep it written down here, and treat undocumented settings as drifting by default.
- **Do NOT enable Stalwart's automated DNS.** It can publish MX, SPF, DKIM, DMARC, TLSA and
  autoconfig records directly against a zone. `willeke.com` is shared with Scott's father, where
  Google must remain MX — a mail server that helpfully publishes an MX pointing at itself would be
  the most destructive thing that could happen to this design. Nothing here needs it: cert-manager's
  HTTP-01 challenge needs no DNS record at all.
- **Rotating the Google account password revokes every app password on that account**, including
  the relay's — a routine password change stops outbound mail for every mailbox on this server,
  and the symptom is an SMTP AUTH failure in the queue log with nothing naming the cause.
  Authenticating as a dedicated role account instead of a person's would remove this coupling; as
  of 2026-08-29 it is still a personal account.
- **The residential WAN IP appears in the headers of every message sent from here** —
  `Received: from mail.activescott.com ([<wan ip>]) by smtp-relay.gmail.com with ESMTPS`.
  Unavoidable for self-hosted mail, not a misconfiguration, but every recipient can see the home
  address and that the hostname resolves to it.
- **DSNs use a null envelope sender** (`MAIL FROM:<>`), and Google's relay does not support
  multiple `RCPT TO` on one — single-recipient DSNs are unaffected.
- **Metric names have no prefix and no labels.** Stalwart derives them from internal event ids by
  replacing non-alphanumeric characters with `_` (`queue.count` → `queue_count`), so several
  collide with names other exporters use (`http_request_time`, `auth_failed`, `dns_lookup_time`).
  **Every query must qualify with `{job="stalwart"}`.** The full id list is only in the upstream
  source, `crates/trc/src/event/enums_impl.rs` — not published in the docs.
- **`PayloadIdentifier` is a fixed string** in both onboarding profiles — installing a profile
  twice on one device _replaces_ the account rather than adding a second, and both profiles share
  the identifier, so installing one replaces the other. Fine for one mailbox per person.
- **The nginx address-substitution regex is the entire defence against XML injection** in the
  onboarding profiles, served unauthenticated. The character class in `nginx-default.conf` admits
  no `<`, `>`, `&`, `"`, `'`, `%` or whitespace — **do not widen it**, or a crafted link could hand
  someone an account pointed at an attacker's server. Anything that fails to match redirects to the
  mail-only profile instead of serving a half-substituted file. `ngx_http_sub_module` must remain
  present in the nginx image, or every templated profile silently ships the literal `__EMAIL__` —
  it's compiled into the official images but not guaranteed in a minimal/distroless variant.
- **`MtaOutboundStrategy`'s `match` field is a map keyed by stringified index** (`"0"`, `"1"`,
  ...), not a JSON array — same encoding as `MtaDeliverySchedule.retry.intervals`. Sending it as an
  array fails cleanly with `error: invalidPatch | ... Properties: route/match` before touching the
  live server. Per `stalwart-config/README.md`: derive this JSON from
  `./scripts/stalwart-apply snapshot <Object>` against the live server, never hand-write it.
- **DKIM on relayed mail is verified, not assumed** — Google's docs never state whether the relay
  applies the sending domain's DKIM key. Measured 2026-08-29: Google signs with `willeke.com`'s own
  `google._domainkey` selector (not a `*.gappssmtp.com` fallback) and adds its own `d=1e100.net`
  signature; `From:`/`Return-Path:` arrive unmodified. DMARC would have passed on SPF alignment
  alone, so nothing depended on this — recorded so the next person doesn't have to re-derive it.
- **Ports**, verified on the node 2026-08-28:

  | Port      | Where                                       | Why                                                                                     |
  | --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | 25        | LoadBalancer, **and** the firewall NAT rule | Google's dual-delivery routing rule connects here.                                     |
  | 993, 465  | LoadBalancer, **and** the firewall NAT rule | Scott's own clients: IMAP and submission. Internet-facing since Tailscale isn't in use. |
  | 587       | published, but **nothing listens**          | Submission is on 465 with implicit TLS (RFC 8314); no STARTTLS listener starts on 587. |
  | 443, 8080 | ClusterIP only                              | Admin UI and JMAP — not exposed as mail ports.                                         |

  25/465/993 accept connections; 587/995 refuse (995 refuses because the Service doesn't publish
  it, so klipper never forwards it).
- **Both provisional alert thresholds were retuned 2026-09-01** against real traffic, replacing
  numbers written when the namespace was a day old. The original note recorded inbound volume as
  ~1 message/day; it is **~49/day**, and the minimum of a rolling window stepped hourly over the
  preceding three days never reached zero — 4h/2, 6h/6, 8h/8, 12h/14 messages. So
  `StalwartNoInboundMail` went **36h → 12h**, roughly 14x margin over the quietest half-day
  actually seen and detection in ~12.5h instead of ~36.5h. `StalwartAuthFailures` went **20/hour →
  5/hour**: the baseline is genuinely zero (7 days, 378k log lines, 1675 `auth.success` and no
  `auth.failed`, because scanners are stopped by the ban machinery before they authenticate — 237
  `security.ip-blocked`, 3 `security.scan-ban`), and the failure worth catching first is a client
  stuck on a stale password, which retries at under 20/hour and earns the source address a
  **permanent** ban.
- **Do not use `proxyTrustedNetworks`** to fix the auto-ban issue above — it looks like the right
  setting and isn't: it makes Stalwart _require_ a PROXY protocol header from matching peers
  (Traefik doesn't send one), and the system-level list applies to every listener including SMTP
  and IMAP. **Bans are permanent by default** — `authBanPeriod`, `scanBanPeriod`, `abuseBanPeriod`
  and `loiterBanPeriod` are all unset out of the box (Settings › Security › Settings).

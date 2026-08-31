# email-stalwart — self-hosted mailboxes for willeke.com

Receives a **copy** of mail for `scott@willeke.com` and serves it over IMAP. Google Workspace
stays the authoritative MX and keeps its own copy of every message; this server is additive and
never load-bearing for account recovery. That is the whole safety argument for Phase 7 — see
`docs/specs/email-infrastructure/spec.md` in the private repo.

This is the _inbound personal mail_ path. It is unrelated to `email-relay/`, which is the
_outbound application_ path. They are deliberately separate services so a mistake in one cannot
affect the other.

## Deployed 2026-08-28

Listed in `apps/production/kustomization.yaml` and live. It went through the same staging as
email-relay: the directory stayed out of that file until `.env.secret.stalwart.encrypted` existed
and the owner-approval steps below were done.

The staging sequence, kept for the record:

1. ~~**Fill `.env.secret.stalwart`**~~ — done 2026-08-28, encrypted.
2. ~~**DNS**~~ — done 2026-08-28, but **not** at the name originally planned. `mail.willeke.com`
   is live and in use: it is a CNAME to `ghs.googlehosted.com` that Scott's father uses to reach
   Gmail, and `willeke.com` is a shared domain. The hostname is now
   **`mail.activescott.com`** — a Cloudflare zone, so the record is git-managed
   (`infrastructure/prod/dns/zones/activescott.com.yaml`) rather than hand-edited in Google Cloud
   DNS. Google's routing rule accepts an arbitrary hostname, so nothing requires it to live in
   the recipient's domain.
3. ~~**OPNsense NAT rule** forwarding `:25`~~ — done 2026-08-28, and inbound `:25` was
   **measured open**, not assumed. Method recorded in the private repo's `scott-todo.md` item 2.
4. ~~**NAT rules for `:993` and `:465`**~~ — done 2026-08-28. Tailscale is not in use, so mail
   clients reach IMAP and submission over the internet. Exposure accepted by Scott. Both measured
   reachable from outside. **Not `:587`** — nothing listens on it; see Ports below.
5. ~~**Google Workspace routing rule** for dual delivery~~ — done 2026-08-28. The settings are
   click-ops and live only in Google's console, so they are recorded in the private repo at
   `docs/specs/email-infrastructure/google-workspace-routing.md`.

Step 5 is what makes mail actually arrive. Everything before it was inert.

## Before the first start: create the volume directories

`hostPath` volumes are not chowned by the kubelet, and the image runs as uid/gid 2000. The two
directories must exist and be owned by 2000 _before_ the pod starts, or Stalwart cannot open its
datastore — which presents as it dropping back into bootstrap mode, i.e. looking exactly like
data loss.

```bash
ssh nas 'sudo mkdir -p /mnt/thedatapool/app-data/stalwart/prod/{config,data} \
  && sudo chown -R 2000:2000 /mnt/thedatapool/app-data/stalwart'
```

Both paths sit under `/app-data/`, which is already on the B2 cloud sync task's include list, so
no backup configuration changes.

## Configuration lives in the database, not in git

Stalwart v0.16 keeps all of its settings — listeners, TLS/ACME, domains, rules — in its own
datastore. There is no config file to declare and no `config apply` command (verified against
`stalwartlabs/stalwart:v0.16`, whose entire CLI is `--config`, `--export`, `--import`,
`--console`). The old REST admin API was removed in the same release.

So this one service is a **recorded exception** to this repo's git-as-source-of-truth rule. Two
consequences worth carrying:

- `stalwart-data` PV is the only copy of the configuration as well as the mail. Restoring this
  service means restoring that volume.
- Nothing in git describes what this server actually does. Keep that written down here as it is
  set up, and treat this README as drifting by default.

## First run

The pod starts in bootstrap mode and opens :8080 for setup. There is no ingress for it.

```bash
kubectl --context nas -n email-stalwart port-forward svc/stalwart-admin 8080:8080
# then open http://127.0.0.1:8080/admin
```

Log in with the `STALWART_RECOVERY_ADMIN` pair from the secret, not with the one-time password
printed to stdout — pinning it is the reason that variable is set.

Note the admin web UI is **downloaded at runtime** from
`https://github.com/stalwartlabs/webui/releases/latest/download/webui.zip`, so the pod needs
egress to GitHub to be administrable, and it tracks `latest` rather than the image tag.

## TLS

**cert-manager issues it over HTTP-01**, exactly like every other hostname in this cluster.
Stalwart's own ACME client is not used, and no Cloudflare token is involved.

The thing that makes this work, and that is easy to talk yourself out of: HTTP-01 does not
require the _mail server_ to answer on :80. cert-manager publishes the challenge through Traefik,
which owns :80 and :443 on the node, and Stalwart only ever reads the finished certificate from
disk. A non-HTTP service can hold an HTTP-01 certificate.

`stalwart-certificate.yaml` declares it; the Secret `stalwart-tls` is mounted read-only at
`/etc/stalwart-tls` by the StatefulSet.

### Registering the certificate (a manual step, and a trap)

cert-manager issues the certificate, but Stalwart will not _use_ it until a `Certificate` object
exists in its database pointing at the mounted files. That configuration is not in git — it
lives in Stalwart's own store — so it must be recreated by hand after any rebuild:

**Settings → TLS → Certificates → Create**, both as **File** references:

| Field       | Value                       |
| ----------- | --------------------------- |
| Certificate | `/etc/stalwart-tls/tls.crt` |
| Private key | `/etc/stalwart-tls/tls.key` |

Use File references, never pasted PEM text. Pasted text is a copy frozen in the database; it
would not change when cert-manager renews, so renewal would silently do nothing.

**Saving it is not enough.** Observed 2026-08-28: after saving, the admin UI displayed the
certificate and its domain correctly — it reads the file at save time to extract SANs — while
the server kept logging `WARN No TLS certificates available (tls.no-certificates-available)
total = 0` and kept serving its self-signed placeholder on every port. Deleting the pod fixed
it at once.

Two lessons: a correct-looking admin UI is not evidence that TLS is being served, and **a
restart is a proven way to load certificates** where the documented `ReloadTlsCertificates`
action is not present in this version's UI at all. Always check the wire:

```bash
openssl s_client -connect 10.1.111.20:993 -servername mail.activescott.com </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates
```

### Do NOT enable Stalwart's automated DNS

Stalwart can publish and maintain MX, SPF, DKIM, DMARC, TLSA and autoconfig records directly
against a zone. **Leave that off.** It is a second writer competing with the project's tenet
that git is the source of truth, and the domain it would write to is `willeke.com` — shared
with Scott's father, where Google must remain MX. A mail server that helpfully publishes an MX
pointing at itself is the most destructive thing that could happen to this design.

Nothing here writes DNS. cert-manager's HTTP-01 challenge needs no record at all, which is one
more reason to keep Stalwart's DNS automation off rather than "off for now".

DKIM is not configured, because Stalwart signs nothing — see Sending below.

Stalwart also reports that its resolver cannot validate DNSSEC and therefore disables DANE. That
is fine for a receive-only role but forecloses TLSA if this ever becomes authoritative.

## Ports

| Port      | Where                                       | Why                                                                                                                                            |
| --------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 25        | LoadBalancer, **and** the firewall NAT rule | Google's routing rule connects here. Verified reachable from the internet 2026-08-28.                                                          |
| 993, 465  | LoadBalancer, **and** the firewall NAT rule | Scott's own clients: IMAP and submission. Internet-facing because Tailscale is not in use; exposure accepted 2026-08-28.                       |
| 587       | published, but **nothing listens**          | Stalwart's default config puts submission on 465 with implicit TLS (RFC 8314) and starts no STARTTLS listener. Do not forward it.              |
| 443, 8080 | ClusterIP only                              | Admin UI and JMAP. Not exposed as mail ports; `admin.mail.activescott.com` reaches 8080 through Traefik, which already holds :443 on the node. |

Verified on the node 2026-08-28 after setup: 25, 465 and 993 accept connections; 587 and 995
refuse. 995 refuses because the Service does not publish it, so klipper never forwards it.

## HTTP arrives through Traefik, and Stalwart must be told so

Both HTTP hostnames reach :8080 through the ingress controller, so without configuration every
request looks to Stalwart like it came from Traefik's pod IP. Its auto-ban then counts the whole
internet's behaviour against one address and eventually bans the ingress controller — which takes
out the admin UI and CalDAV/CardDAV for everyone at once, while `/setup` keeps working because
that is a separate nginx.

This happened on 2026-08-29: 430 `security.ip-blocked` events in 24 hours, all naming
`172.16.2.88`, with `admin.mail.activescott.com` and `/dav/*` returning 502. The trigger was
almost certainly `scanBanRate` — 30 hits/day against `scanBanPaths` globs (`*/wp-*`, `*.php*`,
`*xmlrpc*`, …), which internet background noise reaches in hours against a public admin UI. Note
a DAV client's initial 401 is _not_ an auth failure and does not count.

Two click-ops settings prevent it, both applied 2026-08-29:

| Where                                          | Setting                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Settings › Network › Services › HTTP › General | Proxy → **Obtain remote IP from Forwarded header** = on (`useXForwarded`) |
| Settings › Security › Allowed IPs              | `172.16.0.0/16`, reason "cluster pod CIDR (Traefik ingress)"              |

`useXForwarded` is the actual fix: Stalwart then takes the client IP from `X-Forwarded-For` and
bans the real scanner. It is safe here only because k3s's Traefik sets no
`forwardedHeaders.trustedIPs` and therefore **strips** any client-supplied `X-Forwarded-For`
before adding its own — Stalwart reads the first element of that list, so a Traefik configured to
trust client headers would make bans trivially evadable. Re-check this if Traefik's args change.

The allow-list entry is the belt-and-braces half, and it is what recovers a live outage:
`is_ip_blocked()` ends in `&& !is_ip_allowed(ip)`, so an allow-listed address is both
un-blockable and un-bannable, and an existing block record against it stops mattering
immediately.

Two related things worth knowing before debugging this again:

- **Bans are permanent by default.** `authBanPeriod`, `scanBanPeriod`, `abuseBanPeriod` and
  `loiterBanPeriod` are all unset out of the box, which means no expiry. Settings › Security ›
  Settings.
- **Do not use `proxyTrustedNetworks` for this.** It looks like the right setting and is not: it
  makes Stalwart _require_ a PROXY protocol header from matching peers, Traefik does not send
  one, and the system-level list applies to every listener including SMTP and IMAP.

If it does get banned, the way back in is a port-forward, which bypasses Traefik and arrives as
loopback — always allowed:

```bash
kubectl --context nas -n email-stalwart port-forward stalwart-0 8081:8080
```

## Sending

Stalwart delivers **nothing** directly. Outbound :25 is blocked by Ziply (Phase 0e), so a
message submitted here could never reach a recipient's MX.

Instead it relays through Google Workspace's **SMTP relay service**, `smtp-relay.gmail.com:587`
over STARTTLS, authenticated with a Google app password.

This keeps `willeke.com`'s DNS untouched. Google remains the entity that sends, so the existing
`v=spf1 include:aspmx.googlemail.com ~all` still passes. **No SPF, MX, DMARC or DKIM change is
needed** — which matters because that SPF record is domain-wide on a domain shared with Scott's
father, and a mistake in it would break his outbound mail.

Sending through Stalwart is also what populates its Sent folder, so the archive covers outbound
without a second Google routing rule.

### `smtp-relay.gmail.com`, not `smtp.gmail.com`

They are different services and the distinction is the whole design.

`smtp.gmail.com` is _submission_ — you send as yourself, and Google rewrites `From:` to the
authenticated account unless the address is a verified "Send mail as" alias. That is exactly the
bug this whole project started from (`activescott/fernfiles#204`, where mail sent as
`noreply@fernfiles.com` arrived as `scott@pingpoet.com`).

`smtp-relay.gmail.com` is a _relay_, built for on-prem mail servers sending on behalf of many
people. Its **Allowed senders** setting governs the From address at the domain level, not the
account level. Google's documentation is explicit:

> Message count is based on the sender address used in the SMTP relay transaction. If the
> envelope sender is not a user registered with your Google Workspace account, the per-user
> limits don't apply. **Addresses in the From: and Reply-to: fields are ignored.**

Practical consequences, and the reason a second mailbox on this server is not a special case:

- **Any address at `willeke.com` can send**, whether or not it is a Google Workspace user. Adding
  a mailbox here is a Stalwart-only change; nothing on the Google side needs touching.
- **The 10,000 messages/day quota is charged to the envelope sender**, not to the account that
  authenticated. One shared credential does not become one shared quota bucket.
- The only rewrite Google documents applies under _Any addresses_ for a domain you do not own,
  and it rewrites to `postmaster@<your domain>` — never to the authenticating user.

Google Admin console → Apps → Google Workspace → Gmail → Routing → **SMTP relay service**.
Requires the _Gmail Settings_ admin privilege, is configurable at the top-level organization
only, and changes can take up to 24 hours to apply.

| Setting                                          | Value                        |
| ------------------------------------------------ | ---------------------------- |
| Allowed senders                                  | Only addresses in my domains |
| Only accept mail from the specified IP addresses | unchecked                    |
| Require SMTP Authentication                      | checked                      |
| Require TLS encryption                           | checked                      |

The IP-allowlist option is the one credential-free mode Google offers, and it is unusable here:
this is a residential DHCP line with a 30-minute lease whose address changed twice in August
2026, and the setting is click-ops with no API. There is no third option — no service account,
no OAuth client, no domain-level token authenticates to `smtp-relay.gmail.com`. XOAUTH2 cannot
be domain-level by construction, since its SASL response carries a named `user=` address.

Port 587 with STARTTLS rather than 465: Google's documentation names only 587 for TLS, and
mentions 465 solely in its "not using TLS encryption" paragraph, which also states that without
TLS you cannot use SMTP authentication at all. 465 works in practice; 587 is what is documented.

### The route lives in Stalwart's datastore, not in this repo

Since v0.16 there is no TOML configuration — `/etc/stalwart/config.json` describes only the
datastore, and everything else is a JMAP object inside it. So the two objects below are
click-ops and this README is their only record.

**Settings › MTA › Outbound › Routes**, a route of type `Relay`:

| Property       | Value                                                 |
| -------------- | ----------------------------------------------------- |
| `name`         | `google-willeke-com-relay`                            |
| `address`      | `smtp-relay.gmail.com`                                |
| `port`         | `587`                                                 |
| `protocol`     | `smtp`                                                |
| `implicitTls`  | false (so STARTTLS is used)                           |
| `authUsername` | the Google account holding the app password           |
| `authSecret`   | `EnvironmentVariable` → `STALWART_SMARTHOST_PASSWORD` |

`authSecret` supports an environment-variable reference, which is why the app password lives in
`.env.secret.stalwart.encrypted` and is injected by `stalwart-statefulset.yaml` rather than being
typed into a web form. Note that Stalwart resolves it **once at configuration-build time**: a
rotated Secret needs a pod restart, and a value it cannot resolve degrades the route to
_unauthenticated_ relay instead of erroring.

**Settings › MTA › Outbound › Strategy**, the `route` expression. The shipped default is:

```json
{
  "match": [{ "if": "is_local_domain(rcpt_domain)", "then": "'local'" }],
  "else": "'mx'"
}
```

Both `match.0.if` and `else` are overridden from the shipped default, and the live plan (not
click-ops — `stalwart-config/plan.ndjson`) is now:

```json
{
  "match": [{ "if": "is_local_domain(rcpt_domain) && key_exists('willeke-local-mailboxes', to_lowercase(rcpt))", "then": "'local'" }],
  "else": "'google-willeke-com-relay'"
}
```

The stock condition was `is_local_domain(rcpt_domain)` alone, which routes **every**
`@willeke.com` address to `'local'` — the whole domain is local, not just
`scott@willeke.com`. First shipped that way 2026-08-31 and it broke a real send: the RCPT
stage accepted `micah@willeke.com` fine (see `stalwart-config/README.md`'s "Split-delivery
relay" section for that half), but delivery then tried the `local` route anyway, found no
such mailbox, and bounced with a DSN back to Scott instead of the immediate client-side
rejection the first bug produced — same underlying cause, different symptom, one fix
missed the other. The condition now also checks `willeke-local-mailboxes` (the same
`MemoryLookupKey` list the RCPT-stage guard uses), so `'local'` only fires for addresses
that are real mailboxes on this server; every other `@willeke.com` address falls to
`else` and goes out through the smarthost like any other domain.

The value is the route's `name`, and the inner single quotes are part of the expression syntax —
it is a string literal inside a string. A name that does not resolve to a route is not an error:
delivery falls back, so mail keeps attempting direct MX and expiring, which looks identical to
having made no change at all. Confirm from the queue log that a delivery attempt names
`smtp-relay.gmail.com`.

### Restart the pod after changing MTA settings

**Saving a setting in the admin UI is not the same as the running server using it.** This is the
single most expensive thing to not know about this service, and it has now cost time twice:

- A message submitted ~30 seconds after the outbound strategy was saved still went to direct MX
  and timed out. The configuration in force had been built before the save.
- Deleting a `BlockedIp` record removed it from the datastore — the UI correctly showed it
  gone — while the running process kept dropping that address at TCP accept from a stale
  in-memory copy. Blocked addresses are only reloaded at bootstrap.

Both were resolved by `kubectl --context nas -n email-stalwart rollout restart statefulset/stalwart`.
So: change the setting, restart, _then_ test. A test between those two steps produces a result
about the old configuration and reads exactly like the change not working.

Verified 2026-08-29 after a restart: submission on 465 → queued → `delivery.connect` to
`smtp-relay.gmail.com:587` → STARTTLS TLSv1.3 → `250 OK`, 469 ms, envelope sender preserved as
`scott@willeke.com`.

### Failure modes to know before debugging

- **Rotating the Google account password revokes every app password on that account.** Google
  documents this. A routine password change therefore stops outbound mail for every mailbox on
  this server, and the symptom is an SMTP AUTH failure in the queue log rather than anything
  naming the cause. Authenticating as a dedicated role account rather than a person's account
  removes this coupling; as of 2026-08-29 it is a personal account and this is a known risk.
- **DSNs use a null envelope sender** (`MAIL FROM:<>`), and Google documents that the relay does
  not support multiple `RCPT TO` with one. Single-recipient DSNs are unaffected.
- **Your residential WAN IP appears in the headers of every message sent from here.** The relay
  records the submitting host: `Received: from mail.activescott.com ([<wan ip>]) by
smtp-relay.gmail.com with ESMTPS`. Unavoidable for self-hosted mail and not a misconfiguration,
  but every recipient can see the home address and that the hostname resolves to it.

### DKIM on relayed mail — verified, and it is the good outcome

Google's documentation never states whether the relay service applies a sending domain's DKIM
key, and third-party sources contradict each other. Measured 2026-08-29 by reading the headers
of a message received through the relay:

```
DKIM-Signature: v=1; a=rsa-sha256; d=willeke.com; s=google; darn=rapidsos.com
Authentication-Results: mx.google.com;
  dkim=pass header.i=@willeke.com header.s=google;
  spf=pass smtp.mailfrom=scott@willeke.com;
  dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=willeke.com
```

So Google signs with the domain's own `google._domainkey.willeke.com` selector — not a
`*.gappssmtp.com` fallback — and adds a second `d=1e100.net` signature of its own. DKIM aligns on
`willeke.com`, SPF passes on Google's egress IP, DMARC passes. `From:` and `Return-Path:` both
arrived unmodified, which is the no-rewrite behaviour confirmed on the wire rather than inferred
from documentation. Google also stamps `X-Relaying-Domain: willeke.com`.

DMARC would have passed on SPF alignment alone, so nothing depended on this; it is recorded so
the next person does not have to re-derive it.

## Onboarding a mail client — send people to `/setup`

**<https://mail.activescott.com/setup>**

That page has the whole procedure: create an app password, install the configuration profile,
and the manual host/port table for anything that is not Apple Mail. Hand out the URL; nothing
else needs explaining, and nothing about it is per-user.

The page asks for the user's address and builds a link to
`/setup/profiles/<address>/apple.mobileconfig`, which is the same profile with the address substituted into
all five places it appears. That profile sets up **mail, calendar and contacts** in one install.
`/setup/apple.mobileconfig` is the fallback for anyone who does not enter an address — mail only, with
Apple prompting for the identity.

`/robots.txt` disallows everything. The page is meant to be handed to a person, and the profile
URLs carry an email address.

### Why a configuration profile at all

Apple Mail cannot be pointed at this server by hand on iOS. The New Account screen shows no port
fields, and it will not save the account until both servers verify — so there is no way to reach
the screen where the ports could be corrected. Verification fails because iOS probes submission
on 587, gets refused, then falls back to **25**, which is the MTA listener and advertises no
`AUTH`. Mail then reports **"incorrect username or password"**, which is false: the server log
shows no failed authentication, because none was ever attempted.

An Apple configuration profile (`.mobileconfig`) sidesteps the probe by stating the ports as
fact. Hosting it is what makes it self-service.

### Two profiles, and why

| Path                                           | Payloads                | Identity                     |
| ---------------------------------------------- | ----------------------- | ---------------------------- |
| `/setup/apple.mobileconfig`                    | mail only               | none — Apple prompts for it  |
| `/setup/profiles/<address>/apple.mobileconfig` | mail + CalDAV + CardDAV | address substituted by nginx |

The mail-only one carries no DAV payloads deliberately. `CalDAVUsername` and `CardDAVUsername`
are documented as _required_ rather than prompted, so a DAV payload without one may fail to
install rather than ask — unlike `EmailAddress`, where Apple explicitly documents the prompt.
The templated profile knows the address, so all three payloads are safe there.

Neither carries a password. Apple's reference restricts the password keys to encrypted profiles
and both of these are served in the clear. The cost is **three password prompts** on the
templated profile — mail, calendar, contacts — all taking the same app password. There is no
"same as" key spanning payloads; `OutgoingPasswordSameAsIncomingPassword` only collapses the two
mail prompts into one.

Consequence worth knowing: `PayloadIdentifier` is a fixed string, so installing a profile twice
on one device _replaces_ the account rather than adding a second. Fine for one mailbox per
person. Both profiles share that identifier, so installing one replaces the other.

### The substitution, and the one thing holding it safe

nginx serves `apple-templated.mobileconfig` through `sub_filter`, replacing `__EMAIL__` with the
address captured from the request path. Two decisions in `nginx-default.conf` are load-bearing:

- **The address comes from the path, not a query argument.** nginx decodes `%XX` in the path
  before matching but does not decode query arguments, so `?email=a%40b.com` would need
  hand-rolled decoding. A path segment avoids that and gives the download a sensible filename.
- **The `map` regex is the entire defence against XML injection.** These profiles are served
  unauthenticated, so a crafted link that injected markup could hand someone an account pointed
  at an attacker's server. The character class admits no `<`, `>`, `&`, `"`, `'`, `%` or
  whitespace. **Do not widen it.** Anything that fails to match yields an empty value and is
  redirected to the mail-only profile rather than served a half-substituted file.

Verified 2026-08-28 against the real image: `scott@willeke.com` and `scott%40willeke.com` both
substitute five occurrences and leave zero `__EMAIL__` behind; the result passes `plutil -lint`;
an address containing angle brackets 302s to the fallback, as does anything that is not an
address at all.

`ngx_http_sub_module` must be present in the image or every templated profile silently ships the
literal `__EMAIL__`. It is compiled into the official nginx images; a switch to a minimal or
distroless variant would break this without any error.

### Calendar and contacts

IMAP carries mail only, which is why an IMAP-only account shows Mail and Notes on iOS but no
Calendar — Notes rides on IMAP as messages in a folder. Calendar and contacts need CalDAV and
CardDAV over HTTPS, which Stalwart serves on its HTTP listener.

The Ingress routes `/dav` plus `/.well-known/caldav` and `/.well-known/carddav` on this hostname
to `stalwart-admin:8080`. Apple discovers the endpoints by requesting the well-known paths;
verified 2026-08-28 that Stalwart answers them with a 307 to `/dav/cal` and `/dav/card`, and that
`/dav/cal/` and `/dav/card/` then return 401.

The profiles set no `CalDAVPrincipalURL`/`CardDAVPrincipalURL` and rely on that discovery. If it
ever breaks, add `/dav/cal/` and `/dav/card/` explicitly.

Only those paths are routed here, so Stalwart's admin UI remains reachable solely at
`admin.mail.activescott.com`. This hostname exposes the DAV API and nothing else of Stalwart's.

### Every user needs their own app password

Two-factor is enabled on these accounts, and IMAP and SMTP cannot do a two-factor login. Plain
`AUTH PLAIN`/`LOGIN` with the sign-in password fails. Each user creates their own under
**Account → App Passwords** in the Stalwart UI — it acts on the logged-in user and requires
re-entering their password, so it is genuinely self-service and needs no admin involvement.

### Changing the page or the profiles

Everything for this lives in `mail-setup/`, which is a self-contained kustomization: its own
`kustomization.yaml` carries the manifests and the `configMapGenerator` for the served content,
and the parent just lists the directory. Nothing about it appears at this directory's top level,
so Stalwart's own manifests stay easy to pick out.

Kustomize hashes the content files into the ConfigMap names, so editing the page or either
profile rolls the `mail-setup` Deployment on the next reconcile. Do not convert them to inline
ConfigMaps — the content would then change under a running pod without restarting it.

**Keep the two profiles in sync.** `apple.mobileconfig` and `apple-templated.mobileconfig` share
their mail payload; a port or hostname change has to land in both.

The Ingress routes four things on this hostname, and nothing at `/`:

| Path                   | Type   | Backend          |
| ---------------------- | ------ | ---------------- |
| `/setup`               | Prefix | `mail-setup`     |
| `/robots.txt`          | Exact  | `mail-setup`     |
| `/dav`                 | Prefix | `stalwart-admin` |
| `/.well-known/car*dav` | Exact  | `stalwart-admin` |

Everything user-facing lives under `/setup` — the page, both profiles, and anything added later.
Ingress prefix matching is element-wise, so `/setup` matches `/setup` and `/setup/...` but never
`/setupfoo`. `/robots.txt` is the one exception, because the root is the only location the
standard defines.

That shape is what lets Phase 8's webmail take `/` on this same hostname later: Traefik ranks
routers by rule specificity, so all four beat `PathPrefix(/)`.

## Metrics and alerting

The Grafana dashboard is **Email** (`/d/email`). Its top row is one panel per alert, so anything
that can page has somewhere to be looked at; logs are the three panels at the bottom.

### Two evidence sources, deliberately

| Source                           | Where it comes from                        | Survives                                      |
| -------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `job="stalwart"` metrics         | Stalwart's own Prometheus exporter         | Nothing — it is a datastore setting           |
| `loki_process_custom_stalwart_*` | Alloy counters over the container's stdout | The exporter being off, misconfigured or lost |

The duplication is the point. The exporter is a setting **inside Stalwart's datastore**, which
git does not describe: it can be switched off in the UI, or silently reverted by restoring an
older backup, and no file in this repo would change. Container stdout cannot be switched off from
inside the application. So every question that must still be answerable during an incident — is
mail arriving, is it leaving, is the server locking people out — is answered from logs, and the
exporter supplies only the richer detail that is nice to have on a dashboard.

`StalwartLogFeedDown` is what tells you whether to trust the log-derived panels. While it is
firing, "no inbound mail" means nothing was _recorded_, not that nothing arrived.

### Enabling the exporter

It is off by default and is **not** restored by redeploying this repo.

1. Admin UI → **Settings › Telemetry › Metrics › Prometheus**
2. **Enabled**, `authUsername` = `prometheus`
3. `authSecret` → **Environment variable** → `STALWART_METRICS_PASSWORD`
4. **Restart the pod.** Saving does not apply it — Stalwart builds its configuration at startup,
   so the endpoint keeps returning 404 until it restarts. This is the same trap as the MTA
   settings above, and it is the reason there is no window where the endpoint is live without a
   password: the setting cannot take effect before the Secret that backs it is mounted.

Authentication is not optional here. `/metrics/prometheus` is served on the **same HTTP listener
as the admin UI**, which `stalwart-admin-ingress.yaml` publishes to the internet — there is no way
to bind it separately. `stalwart-metrics-ingress.yaml` blocks the path at the edge as an
independent second layer, because the auth setting lives in the datastore and the ingress rule
lives in git, and each covers the other's blind spot.

Note the failure direction: if Stalwart cannot resolve `STALWART_METRICS_PASSWORD` it degrades the
endpoint to **unauthenticated** rather than failing loudly. That is the dangerous direction, and
the whole reason the ingress block exists rather than relying on auth alone.

The password lives in **two files that must hold the same value**, because they are in two
namespaces and Secrets do not cross one:

| File                                                                 | Key                         | Read by    |
| -------------------------------------------------------------------- | --------------------------- | ---------- |
| `apps/production/email-stalwart/.env.secret.stalwart`                | `STALWART_METRICS_PASSWORD` | Stalwart   |
| `apps/production/monitoring/prometheus/.env.secret.stalwart-metrics` | `stalwart_metrics_password` | Prometheus |

Changing one alone produces a 401 and fires `StalwartMetricsScrapeDown`, which looks identical to
the exporter having been switched off (404). Check the status code before assuming which.

### Adding an Alloy counter needs a DaemonSet restart

Editing `monitoring/alloy/helmrelease.yaml` is not enough, and the failure is worse than the
change not applying. The config-reloader sidecar hot-reloads the ConfigMap into the running
process, but a reload re-registers the `loki.process` counters without unregistering the old
ones, and the Prometheus client library then refuses to serve `/metrics` at all:

```
collected metric "loki_process_custom_email_relay_sent_total" {...}
was collected before with the same name and label values
```

The scrape fails and **every** Alloy-derived series disappears — not just the edited ones.
Observed 2026-08-29 while adding these counters: the email-relay, WAN-flapping and tinkerbell
log-health alerts all went blind together, and the only symptom was alerts quietly not firing.

```bash
kubectl --context nas -n monitoring rollout restart daemonset alloy
```

This is why every alert reading these counters carries an `or absent(...)` arm. A bare `== 0`
cannot fire on a series that does not exist, which is precisely the state this bug produces.

### Counters do not exist until their event happens

Stalwart exports a counter only once its event has occurred since the process started, so a
freshly restarted, idle server exports almost nothing and several dashboard panels correctly read
"No data". Verified 2026-08-29: `message_ingest_ham`, `smtp_dkim_pass`, `smtp_dmarc_pass` and
`queue_message_queued` were all absent until a test message arrived, then appeared at `1`.

Always-present gauges — useful as proof the exporter itself is working — are `user_count`,
`domain_count`, `server_memory` and the `*_active_connections` family.

`queue_count` is the notable absence: it exists only while the queue is non-empty. The
`StalwartQueueBacklog` alert is unaffected (it only needs the metric when there _is_ a backlog),
but any panel reading it needs `or vector(0)`.

To generate real traffic end to end — relay → Cloudflare → Google MX → dual delivery →
Stalwart `:25`:

```bash
./apps/production/email-relay/send-test-email.sh --send-only scott@willeke.com
```

Use `--send-only`. The default mode deliberately fails an authentication to prove the relay's
access controls hold, which now trips `EmailRelayAuthFailures`.

### Metric names have no prefix and no labels

Stalwart derives them from its internal event ids by replacing every non-alphanumeric character
with `_`, so `queue.count` is exported as `queue_count` and `auth.failed` as `auth_failed`. There
is no `stalwart_` prefix. Several therefore collide with names other exporters use
(`http_request_time`, `auth_failed`, `dns_lookup_time`), so **every query must qualify with
`{job="stalwart"}`**. The full id list is in the upstream source at
`crates/trc/src/event/enums_impl.rs`; the documentation does not publish it.

### The certificate alerts, and why there are three

`StalwartServedCertExpiringSoon` and `StalwartCertificateNotRenewing` are the obvious pair —
what is on the wire, and what cert-manager holds. Neither catches the failure this deployment
actually has.

Stalwart does not notice a rotated certificate file. cert-manager renews, the kubelet refreshes
the mounted Secret, and the running server keeps serving the old certificate — see the TLS section
above, where that was observed rather than theorised. cert-manager's metric goes green at the
moment of renewal and stays green for the whole ~60 days the stale certificate is being served, so
it cannot see this at all; the served-certificate threshold does see it, but not until 14 days
before an outage.

`StalwartServedCertNotRenewed` compares the two directly and fires on the gap, roughly a day after
a renewal that did not reload and about 30 days before anything breaks. It is the one worth
having. The **Reload lag** panel on the dashboard shows the same quantity continuously; flat at
zero is correct.

### Provisional thresholds

Two rules were written against ~24 hours of history, because that is all that existed when the
namespace was a day old. Both are deliberately loose — under-alerting was the right way to be
wrong — and both should be retightened once there is a week of data:

- `StalwartNoInboundMail` fires at 36h of silence. Measured inbound volume was **one message per
  day**, so a shorter window would page on an ordinary quiet weekend.
- `StalwartAuthFailures` fires above 20/hour. **Zero** `auth.failed` lines were observed, so this
  is a ceiling picked to avoid noise, not a multiple of a real baseline.

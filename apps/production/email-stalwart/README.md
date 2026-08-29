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

## Sending

Stalwart delivers **nothing** directly. Outbound :25 is blocked by Ziply (Phase 0e), so a
message submitted here could never reach a recipient's MX.

Instead it relays through an authenticated smarthost: `smtp.gmail.com:587`, as Scott's Google
account, configured as a `Relay` route (`authUsername` + `authSecret`, STARTTLS).

This is what keeps `willeke.com`'s DNS untouched. Google remains the entity that sends, so the
existing `v=spf1 include:aspmx.googlemail.com ~all` still passes and Google applies its own
DKIM. **No SPF, MX, DMARC or DKIM change is needed for any of this** — which matters because
that SPF record is domain-wide on a domain shared with Scott's father, and a mistake in it would
break his outbound mail.

Sending through Stalwart is also what populates its Sent folder, so the archive covers outbound
without a second Google routing rule.

## Onboarding a mail client — send people to `/setup`

**<https://mail.activescott.com/setup>**

That page has the whole procedure: create an app password, install the configuration profile,
and the manual host/port table for anything that is not Apple Mail. Hand out the URL; nothing
else needs explaining, and nothing about it is per-user.

### Why a configuration profile at all

Apple Mail cannot be pointed at this server by hand on iOS. The New Account screen shows no port
fields, and it will not save the account until both servers verify — so there is no way to reach
the screen where the ports could be corrected. Verification fails because iOS probes submission
on 587, gets refused, then falls back to **25**, which is the MTA listener and advertises no
`AUTH`. Mail then reports **"incorrect username or password"**, which is false: the server log
shows no failed authentication, because none was ever attempted.

An Apple configuration profile (`.mobileconfig`) sidesteps the probe by stating the ports as
fact. Hosting it is what makes it self-service.

### The profile is identity-free on purpose

It contains no email address, no username, and no password. Apple's payload reference says the
device prompts for `EmailAddress` and the incoming/outgoing usernames when those keys are absent,
so one file serves every user and nothing personal is published at a URL that needs no
authentication. Do **not** add `IncomingPassword`/`OutgoingPassword` — Apple's own guidance
restricts those to encrypted profiles, and this one is served in the clear.

Consequence worth knowing: `PayloadIdentifier` is a fixed string, so installing the profile twice
on one device _replaces_ the account rather than adding a second. Fine for one mailbox per
person.

### Every user needs their own app password

Two-factor is enabled on these accounts, and IMAP and SMTP cannot do a two-factor login. Plain
`AUTH PLAIN`/`LOGIN` with the sign-in password fails. Each user creates their own under
**Account → App Passwords** in the Stalwart UI — it acts on the logged-in user and requires
re-entering their password, so it is genuinely self-service and needs no admin involvement.

### Changing the page or the profile

Both live in `mail-setup/` and are pulled in by the `configMapGenerator` in
`kustomization.yaml`. Kustomize hashes the file contents into the ConfigMap names, so editing
either one rolls the `mail-setup` Deployment on the next reconcile. Do not convert them to inline
ConfigMaps — the content would then change under a running pod without restarting it.

The Ingress serves exactly two paths, `/setup` and `/apple.mobileconfig`, as `pathType: Exact`.
That is what lets Phase 8's webmail take `/` on this same hostname later; Traefik ranks routers
by rule specificity, so an exact path wins over `PathPrefix(/)`. Do not widen them to `Prefix`.

# email-stalwart — self-hosted mailboxes for willeke.com

Receives a **copy** of mail for `scott@willeke.com` and serves it over IMAP. Google Workspace
stays the authoritative MX and keeps its own copy of every message; this server is additive and
never load-bearing for account recovery. That is the whole safety argument for Phase 7 — see
`docs/specs/email-infrastructure/spec.md` in the private repo.

This is the *inbound personal mail* path. It is unrelated to `email-relay/`, which is the
*outbound application* path. They are deliberately separate services so a mistake in one cannot
affect the other.

## Not deployed yet

This directory is **not** listed in `apps/production/kustomization.yaml`, on purpose — the same
staging email-relay went through. It cannot build until `.env.secret.stalwart.encrypted` exists,
and it should not run until the two owner-approval steps below are done.

Blocking, in order:

1. ~~**Fill `.env.secret.stalwart`**~~ — done 2026-08-28, encrypted.
2. ~~**DNS**~~ — done 2026-08-28, but **not** at the name originally planned. `mail.willeke.com`
   is live and in use: it is a CNAME to `ghs.googlehosted.com` that Scott's father uses to reach
   Gmail, and `willeke.com` is a shared domain. The hostname is now
   **`mail.activescott.com`** — a Cloudflare zone, so the record is git-managed
   (`infrastructure/prod/dns/zones/activescott.com.yaml`) and ACME DNS-01 works with a
   Cloudflare token instead of a Google Cloud DNS credential. Google's routing rule accepts an
   arbitrary hostname, so nothing requires it to live in the recipient's domain.
3. ~~**OPNsense NAT rule** forwarding `:25`~~ — done 2026-08-28, and inbound `:25` was
   **measured open**, not assumed. Method recorded in the private repo's `scott-todo.md` item 2.
4. **NAT rules for `:993` and `:587`** — still to do. Tailscale is not in use, so mail clients
   reach IMAP and submission over the internet. Exposure accepted by Scott, 2026-08-28.
5. **Google Workspace routing rule** for dual delivery, in the admin console.

Step 5 is what makes mail actually arrive. Everything before it is inert.

## Before the first start: create the volume directories

`hostPath` volumes are not chowned by the kubelet, and the image runs as uid/gid 2000. The two
directories must exist and be owned by 2000 *before* the pod starts, or Stalwart cannot open its
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

Stalwart does its own ACME; cert-manager here is HTTP-01 only and cannot cover mail hostnames.
Traefik owns :80 and :443 on the node, so an HTTP-01 challenge cannot reach Stalwart — use
**DNS-01**.

Settled 2026-08-28: **DNS-01 against `activescott.com` via Stalwart's own Cloudflare
integration.** Stalwart drives the challenge through the provider API itself, so renewal needs
no manual step. This is the direct consequence of naming the host `mail.activescott.com` — had
it stayed in `willeke.com` (Google Cloud DNS) it would have needed a new credential there.

Needs a **fourth Cloudflare token**, scoped as narrowly as it goes:

```
Zone -> DNS -> Edit
Zone Resources -> Include -> Specific zone -> activescott.com
```

No Crossplane conflict: the `_acme-challenge` TXT is ephemeral and undeclared in git, and the
`DNSZone` composition reconciles only records it declares — it does not prune unknown records
from the zone. Do not re-run `generate-dnszones.sh` while a challenge record is live, or it
could be adopted into git as a permanent record.

### Registering the certificate (a manual step, and a trap)

cert-manager issues the certificate, but Stalwart will not *use* it until a `Certificate` object
exists in its database pointing at the mounted files. That configuration is not in git — it
lives in Stalwart's own store — so it must be recreated by hand after any rebuild:

**Settings → TLS → Certificates → Create**, both as **File** references:

| Field | Value |
|---|---|
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

The ACME DNS-01 automation above is a deliberate exception: it writes one ephemeral TXT record
in a different zone, and nothing in git ever describes that record.

DKIM is not configured, because Stalwart signs nothing — see Sending below.

Stalwart also reports that its resolver cannot validate DNSSEC and therefore disables DANE. That
is fine for a receive-only role but forecloses TLSA if this ever becomes authoritative.

## Ports

| Port | Where | Why |
|---|---|---|
| 25 | LoadBalancer, **and** the firewall NAT rule | Google's routing rule connects here. Verified reachable from the internet 2026-08-28. |
| 993, 465 | LoadBalancer, **and** the firewall NAT rule | Scott's own clients: IMAP and submission. Internet-facing because Tailscale is not in use; exposure accepted 2026-08-28. |
| 587 | published, but **nothing listens** | Stalwart's default config puts submission on 465 with implicit TLS (RFC 8314) and starts no STARTTLS listener. Do not forward it. |

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
| 443, 8080 | ClusterIP only | Admin UI and JMAP. Not exposed; reach by `port-forward`. Traefik already holds :443 on the node IP. |

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

1. **Fill `.env.secret.stalwart`** (placeholder on disk) and let it be encrypted.
2. **`mail.willeke.com` DNS** — repointing an existing record, not adding one. Private repo
   `scott-todo.md` item 10.
3. **OPNsense NAT rule** forwarding `:25` to `10.1.111.20`. Firewall change, needs explicit
   owner approval.
4. **Google Workspace routing rule** for dual delivery, in the admin console.

Steps 3 and 4 are what make mail actually arrive. Everything before them is inert.

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
Configure the ACME provider in the admin UI once `mail.willeke.com` resolves. Traefik owns :80
and :443 on the node, so an HTTP-01 challenge cannot reach Stalwart — use **DNS-01**.

`willeke.com` is hosted at Google Cloud DNS, not Cloudflare, so a Cloudflare DNS-01 token does
not help for that name. Settle the challenge method at the same time as the hostname decision.

Stalwart also reports that its resolver cannot validate DNSSEC and therefore disables DANE. That
is fine for a receive-only role but forecloses TLSA if this ever becomes authoritative.

## Ports

| Port | Where | Why |
|---|---|---|
| 25 | LoadBalancer, **and** the firewall NAT rule | Google's routing rule connects here. The only port that needs to be open to the internet. |
| 587, 465, 993 | LoadBalancer, LAN/Tailscale only | Scott's own clients. Not forwarded at the firewall. |
| 443, 8080 | ClusterIP only | Admin UI and JMAP. Not exposed; reach by `port-forward`. Traefik already holds :443 on the node IP. |

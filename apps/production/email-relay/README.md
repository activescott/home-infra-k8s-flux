# email-relay

A Postfix null client. Applications hand it a message on `relay.email-relay.svc:587` and it
relays to Cloudflare Email Sending over implicit TLS on 465. Nothing here ever talks to a
recipient's MX: Cloudflare makes that hop, which is what makes the whole design work on a
residential connection where outbound 25 is blocked.

The point of the indirection is that applications know exactly one endpoint. Replacing
Cloudflare with SES, or a VPS MTA, or anything else, is a change to one Secret and zero
applications.

## Access control

Three independent layers, because each one alone has a hole:

1. **NetworkPolicy** — only `fernfiles-prod`, `ramblefeed-prod` and `tinkerbell-prod` can open
   the port.
2. **SASL** — `mynetworks` is narrowed to loopback and `smtpd_relay_restrictions` is
   `permit_sasl_authenticated,reject`. Left at the image's default, `mynetworks` would cover
   `172.16.0.0/12`, which contains this cluster's entire pod CIDR — every pod could relay.
3. **`smtpd_sender_login_maps`** — each app's SASL login owns exactly one domain, so a
   compromised app cannot send as another's. Keys are the `@domain` form; a bare `domain` key
   is not a lookup postfix performs and would reject everything.

## Credentials

`.env.secret.relay` holds two values, neither generated or read by an agent:

- `RELAYHOST_PASSWORD` — a Cloudflare API token with **Account → Email Sending → Edit**,
  used as the SMTP password with the literal username `api_token`. Separate from the
  onboarding token so it can be rotated on its own.
- `SMTPD_SASL_USERS` — `user:pass` pairs for the apps, comma separated. Each password must
  match the `SMTP_PASS` in that app's own secret.

Encrypt with `./scripts/encrypt-env-files.sh apps/production/email-relay`.

## The queue is not persistent

`/var/spool/postfix` is an `emptyDir`. Cloudflare accepts or rejects within the connection, so
the queue is empty except during an outage, and mail deferred at the moment of a pod restart is
lost. That is a deliberate trade: a PV would outlive the failure it exists for, and the mail at
risk is sign-in codes, which a user simply requests again. It is also why delivery failures are
alerted on rather than left to retry silently.

## Debugging

```bash
kubectl --context nas -n email-relay logs deploy/relay -f
kubectl --context nas -n email-relay exec deploy/relay -- postqueue -p     # queue contents
kubectl --context nas -n email-relay exec deploy/relay -- postconf -n      # effective config
```

**`productpoet.com` cannot be used as a test sender**, despite being onboarded. It is parked
with no A and no MX at the apex, so `reject_unknown_sender_domain` refuses it before the relay
ever dials Cloudflare:

```
450 4.1.8 <noreply@productpoet.com>: Sender address rejected: Domain not found
```

Test with a real sending domain instead. The relay reads its own SASL passwords from its
environment, so a test needs no credentials on the outside:

```bash
kubectl --context nas -n email-relay exec -i deploy/relay -- python3 - <<'PY'
import os, smtplib
users = dict(p.split(":", 1) for p in os.environ["SMTPD_SASL_USERS"].split(","))
u = "fernfiles@relay.local"
with smtplib.SMTP("127.0.0.1", 587, timeout=30) as s:
    s.login(u, users[u])
    s.sendmail("noreply@fernfiles.com", ["you@example.com"],
               "From: noreply@fernfiles.com\r\nTo: you@example.com\r\n"
               "Subject: relay test\r\n\r\nbody\r\n")
PY
```

A successful delivery logs `status=sent (250 2.0.0 Ok <...@fernfiles.com>)`.

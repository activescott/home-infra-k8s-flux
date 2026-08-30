# Bulwark webmail

JMAP webmail for the mailboxes on this server, at <https://mail.activescott.com/>.
Design and findings: [`docs/specs/webmail-bulwark/plan.md`](../../../../docs/specs/webmail-bulwark/plan.md).

Upstream: [`bulwarkmail/webmail`](https://github.com/bulwarkmail/webmail), AGPL-3.0-only.
**Created 2026-03-13** and releasing roughly weekly, so the image is pinned by digest — an
upgrade should be a reviewed commit, never a consequence of a pod restarting.

## Bringing it up

The directory is deliberately not referenced from `../kustomization.yaml` until the secret
exists. Both changes land together:

1. Create the host directory with the right owner. hostPath volumes are **not** chowned by the
   kubelet, and the image runs as `nextjs` = 1001:1001:

   ```bash
   ssh nas 'sudo mkdir -p /mnt/thedatapool/app-data/bulwark/prod/data \
            && sudo chown -R 1001:1001 /mnt/thedatapool/app-data/bulwark/prod'
   ```

2. Make the secret — **you**, not the agent, for the reason in the template's banner:

   ```bash
   cp env.secret.bulwark.example .env.secret.bulwark
   $EDITOR .env.secret.bulwark
   ../../../../scripts/encrypt-env-files.sh apps/production/email-stalwart/bulwark
   ```

3. Uncomment `secretGenerator` in `kustomization.yaml`, add `- bulwark` to
   `../kustomization.yaml`, commit.

## How login works

OAuth against Stalwart, which is a full OIDC provider. There is **no password form**
(`OAUTH_ONLY=true`): basic JMAP auth cannot carry a second factor, so leaving it reachable
would be a weaker way into accounts that have 2FA, and would put app passwords back into
browsers — which is the thing choosing OAuth was meant to avoid.

The client is **public**, with no secret: Stalwart advertises PKCE `S256` and a token endpoint
auth method of `none`. It is declared as an `OAuthClient` in `../stalwart-config/plan.ndjson`
rather than clicked into the admin UI.

`requireClientRegistration` is on and `anonymousClientRegistration` off, both set in that same
plan. Before this phase they were the other way round, which was survivable only because no
OIDC endpoint was routed publicly.

## Two things that will look like bugs

**The redirect URIs list 27 locales.** The published image is built with
`NEXT_PUBLIC_LOCALE_PREFIX=always`, so every page lives under a locale segment and the OAuth
callback is `/en/auth/callback`, not `/auth/callback`. The locale comes from the browser's
`Accept-Language`, so a user with a German browser lands on `/de/auth/callback`; registering
only English would fail for them with a redirect-URI mismatch. `NEXT_PUBLIC_*` is baked at
build time — setting it in the Deployment does nothing, which was verified by trying it.

**Stalwart owns `/login` on this hostname.** That is its OAuth authorization endpoint. It only
works because Bulwark's own login page is at `/en/login`. If a future image is ever built with
a different locale-prefix mode, the two collide and the symptom is a login loop.

## Verifying

```bash
# Existing routes must not have moved -- Traefik rule specificity is the assumption this
# phase rests on.
for p in /setup /dav /.well-known/caldav /.well-known/openid-configuration /jmap/session; do
  printf '%-40s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://mail.activescott.com$p)"
done

# Client registration must stay shut, from outside.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mail.activescott.com/auth/register
```

# Standardize TLS certificate management across the repo

## Why

The cert-manager v1.20.2 upgrade
([summary](../cert-manager-upgrade-1.12-to-1.20/summary.md)) surfaced
that the repo mixes two TLS-cert patterns inconsistently:

1. **Annotation-driven** — `cert-manager.io/cluster-issuer` on the
   Ingress; `ingress-shim` auto-creates a `Certificate` resource.
2. **Explicit `Certificate` manifest** — a stand-alone YAML resource.

Four apps had **both** for the same secret, which v1.12 silently
tolerated but v1.20 reports as `Ready=False, IncorrectCertificate`.
Those four were cleaned up in commit `60d0099` by removing the
explicit Certificate files and letting the annotation continue.

This spec covers standardizing the remaining inconsistencies and
documenting the chosen convention so future additions stay
consistent.

## Current inventory (post-upgrade, post-cleanup)

### Explicit Certificate manifests still in the repo (7)

- `apps/base/home-assistant/certificate.yaml`
- `apps/base/transmission/certificate.yaml`
- `apps/production/scott-willeke-com/certificate.yaml`
- `apps/production/coinpoet-redirect/certificate.yaml`
- `apps/production/monitoring/grafana/certificate.yaml`
- `apps/production/monitoring/prometheus/certificate.yaml`
- `infrastructure/base/configs/image-scanning-webhook-receiver/certificate.yaml`

### Ingresses (or HelmRelease patches) using the annotation

- `apps/production/gpupoet/www-redirect-ingress.yaml`
- `apps/production/wordpress-micah-mmm/patch-helmrelease.yaml`
- `apps/production/photoprism/{oksana,scott,micah}/patch-photoprism-ingress.yaml`
- `apps/production/coinpoet-redirect/ingress.yaml`
- `apps/base/traefik-redirect/ingress.yaml`

`coinpoet-redirect` is interesting — it has **both** an annotation
on the Ingress *and* an explicit Certificate. Worth checking whether
the Ingress's `tls.secretName` and the Certificate's `secretName`
collide (potential next conflict).

## Convention to adopt

**Default: annotation-driven for Ingress-fronted TLS.**

- Cert spec lives next to the Ingress that consumes it.
- No drift between Ingress hosts and Certificate dnsNames.
- Matches what most cert-manager docs and tutorials show.

**Exceptions where an explicit `Certificate` is the right call:**

- Cert is consumed by something other than an Ingress (e.g. a Pod
  mount for non-HTTP TLS, like the flux image-scanning webhook
  receiver — that one stays explicit).
- The cert needs fields that `ingress-shim` doesn't expose:
  - `duration` / `renewBefore` overrides
  - `privateKey.algorithm` / `size` / `rotationPolicy`
  - `keystores` (JKS/PKCS12)
  - `literalSubject`, `otherNames`, `subject.organizations`, etc.
- Cert needs to outlive the Ingress (rare).

## Migration plan

For each of the 7 explicit Certificates above:

1. Read the manifest. If it has **only**
   `commonName`/`dnsNames`/`issuerRef`/`secretName`, it's a candidate
   for migration.
2. Find the Ingress that consumes the secret. Confirm:
   - The Ingress's `tls[].hosts` matches the Certificate's
     `dnsNames`.
   - The Ingress's `tls[].secretName` matches the Certificate's
     `secretName`.
3. Add (or confirm) `cert-manager.io/cluster-issuer: letsencrypt-production`
   annotation on the Ingress.
4. Remove the explicit Certificate file and its `kustomization.yaml`
   reference.
5. Per-app PR (one commit per app) so any reconciliation issue is
   isolated.

**Known keep-as-explicit:**
`infrastructure/base/configs/image-scanning-webhook-receiver/certificate.yaml`
— this cert is mounted into the flux webhook receiver Pod, not
served via an Ingress. Stays explicit.

**Special handling:** `coinpoet-redirect` has both. Investigate first
to confirm it's a duplicate-style conflict, then collapse.

## README updates

Add a "TLS certificates" section to the repo README with:

1. The convention above (default annotation, exceptions list).
2. A copy-paste example of the annotation form for a new Ingress.
3. A copy-paste example of an explicit Certificate for the exception
   cases.
4. Pointer to `letsencrypt-production` (the only currently-enabled
   ClusterIssuer) and note that `letsencrypt-staging` exists in the
   repo but is commented out in
   `infrastructure/prod/controllers/cert-manager/base/clusterissuers/kustomization.yaml`
   — enable it before doing risky cert work.

## Validation after migration

For each migrated app:

- The annotation-managed Certificate appears in the namespace and is
  `Ready=True`.
- The expected Secret exists with a non-expired cert matching the
  expected dnsNames (`openssl x509 -noout -subject -enddate`).
- A live TLS probe still serves the right SAN
  (`curl -vk https://<host>/` from the cluster).

## Out of scope

- Repo-wide refactor of Ingress annotations (host pinning, TLS
  redirects, etc.).
- Migration off Let's Encrypt or to a different issuer.
- Enabling the staging ClusterIssuer — separate small change.

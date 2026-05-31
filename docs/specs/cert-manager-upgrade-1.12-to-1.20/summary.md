# cert-manager v1.12.0 → v1.20.2 — summary

## Outcome

**Successful**, in commit `1b75765`. Single-line URL change in
`infrastructure/prod/controllers/cert-manager/base/cert-manager-manifest/kustomization.yaml`,
pushed to `main`. Flux reconciled within ~90s; all three deployments
rolled cleanly.

## What was upgraded

- `cert-manager` (controller) → `quay.io/jetstack/cert-manager-controller:v1.20.2`
- `cert-manager-cainjector` → `quay.io/jetstack/cert-manager-cainjector:v1.20.2`
- `cert-manager-webhook` → `quay.io/jetstack/cert-manager-webhook:v1.20.2`
- 6 CRDs (`certificates`, `certificaterequests`, `clusterissuers`,
  `issuers`, `challenges`, `orders`) — all stable `cert-manager.io/v1`,
  no API churn.

## Validation evidence

- All three Deployments report `1/1` Ready, 0 restarts on the new image.
- Webhook admission is active and v1.20-aware — confirmed by sending a
  malformed `Certificate` (`dnsNames: []`) and receiving a rejection
  citing the v1.20 schema fields `literalSubject`, `emailSANs`,
  `otherNames`. v1.12 didn't know about those field names.
- Controller starts all 13 sub-controllers and reconciles cleanly.
- 19/23 existing `Certificate` resources transition to `Ready=True`
  immediately after upgrade.
- Single burst of `ACME client for issuer not initialised/available`
  re-queue errors at controller startup (00:46:24) — expected, did
  not recur after the initial reconcile.

## Pre-existing issue surfaced (not a regression)

4 Certificates flipped to `Ready=False, Reason=IncorrectCertificate`:

| Namespace | Failing cert | Sibling that "wins" the secret |
|---|---|---|
| `photoprism-oksana` | `photos-oksana-willeke-com-tls` | `photos-oksana-willeke-com` |
| `photoprism-scott`  | `photos-scott-willeke-com-tls`  | `photos-scott-willeke-com` |
| `photoprism-micah`  | `photos-micah-willeke-com`      | `photos-micah-willeke-com-tls` |
| `wordpress-micah-mmm` | `mmm-willeke-com-tls`         | `mmm-willeke-com` |

Each pair has **two `Certificate` resources** with different names but
**the same `spec.secretName`** in the same namespace. They fight over
the secret; one wins each reconcile, the other reports
`IncorrectCertificate`. In every case one cert is owned by an
`Ingress` (created by `ingress-shim` from the
`cert-manager.io/cluster-issuer` annotation) and the other is the
explicit `certificate.yaml` resource in the repo.

This is **pre-existing repo hygiene** — both resources existed under
v1.12. v1.20 surfaces the conflict with a clearer status; v1.12
likely just rotated which one "won" silently. **No user-facing TLS
impact** — every underlying Secret holds a valid certificate from
Let's Encrypt:

- `photos-oksana-willeke-com-tls`: expires 2026-08-25
- `photos-scott-willeke-com-tls`: expires 2026-08-25
- `photos-micah-willeke-com-tls`: expires 2026-07-10
- `mmm-willeke-com-tls`: expires 2026-07-24

## Follow-ups (not part of this upgrade)

1. **Clean up duplicate Certificates.** For each pair, decide whether
   to keep the explicit `Certificate` resource or rely on
   `ingress-shim`, and remove the loser. Recommend keeping the
   explicit one and removing the `cert-manager.io/cluster-issuer`
   annotation from the matching `Ingress` (more declarative, easier
   to find in code review than annotation magic).
2. The `letsencrypt-staging` `ClusterIssuer` is defined in the repo
   but commented out in
   `infrastructure/prod/controllers/cert-manager/base/clusterissuers/kustomization.yaml`.
   Enabling it would unlock low-risk probe testing for future
   upgrades.

## Rollback (not exercised)

Path remains: `git revert 1b75765`, push, let Flux reconcile back to
v1.12. CRD storage-version downgrade is technically unsupported, but
existing Secrets continue to serve TLS regardless of the controller
version, so a rollback would not be a customer-impacting outage.

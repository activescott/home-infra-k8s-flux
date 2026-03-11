# Summary: WordPress Instance for Micah (mmm.willeke.com)

## What Was Done

Created a reusable WordPress base and Micah's instance overlay for deploying WordPress at `mmm.willeke.com` via Flux GitOps.

### Files Created

**Base (`apps/base/wordpress/`)**
- `kustomization.yaml` - Resources list with buildMetadata
- `helmrepository.yaml` - OCI HelmRepository for Bitnami charts (`oci://registry-1.docker.io/bitnamicharts`)
- `helmrelease.yaml` - HelmRelease for WordPress chart v27.0.0 with common defaults (ingress disabled, persistence enabled, resource limits)

**Overlay (`apps/production/wordpress-micah-mmm/`)**
- `kustomization.yaml` - References base, namespace, certificate, PVs; secretGenerator with `disableNameSuffixHash`; labels for tenant `micah`
- `namespace.yaml` - Namespace `wordpress-micah-mmm`
- `certificate.yaml` - cert-manager Certificate for `mmm.willeke.com` via `letsencrypt-production` ClusterIssuer
- `pv.yaml` - PV+PVC pairs for WordPress data and MariaDB data (hostPath under `/mnt/thedatapool/app-data/wordpress-micah-mmm/`)
- `patch-helmrelease.yaml` - Strategic merge patch enabling ingress, setting blog name, username, TLS, and existingClaim references
- `.env.secret.wordpress-creds` - Plaintext template (must be SOPS-encrypted before committing)

**Edited**
- `apps/production/kustomization.yaml` - Added `./wordpress-micah-mmm` to resources

### Key Decisions
- Used `disableNameSuffixHash: true` on secretGenerator so the HelmRelease `existingSecret: wordpress-creds` reference matches the generated secret name
- Fixed base path to `../../base/wordpress` (2 levels up from `apps/production/wordpress-micah-mmm/` to `apps/`)

### Remaining Steps
1. Set real passwords in `.env.secret.wordpress-creds` and encrypt with SOPS: `sops --encrypt .env.secret.wordpress-creds > .env.secret.wordpress-creds.encrypted`
2. Ensure DNS for `mmm.willeke.com` points to the cluster ingress IP
3. Commit and push — Flux will reconcile and deploy

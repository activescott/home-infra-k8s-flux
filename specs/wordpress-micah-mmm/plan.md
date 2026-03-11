# Plan: WordPress Instance for Micah (mmm.willeke.com)

## Context

Set up a WordPress instance for Micah at `mmm.willeke.com` using the Bitnami WordPress Helm chart via Flux GitOps. Create a reusable WordPress base (`apps/base/wordpress/`) and Micah's instance overlay (`apps/production/wordpress-micah-mmm/`), following the existing base/overlay pattern used by photoprism.

## Files to Create

### 1. Base: `apps/base/wordpress/`

**`apps/base/wordpress/kustomization.yaml`**
- Resources: `helmrepository.yaml`, `helmrelease.yaml`
- `buildMetadata: [originAnnotations, transformerAnnotations]`

**`apps/base/wordpress/helmrepository.yaml`**
- OCI HelmRepository for Bitnami: `oci://registry-1.docker.io/bitnamicharts`
- `type: oci`, interval `168h`

**`apps/base/wordpress/helmrelease.yaml`**
- HelmRelease referencing chart `wordpress` version `27.0.0` from the bitnami HelmRepository
- Common values:
  - `ingress.enabled: false` (overlay enables with instance-specific hostname)
  - `persistence.enabled: true` (overlays provide existingClaim)
  - `mariadb.primary.persistence.enabled: true` (overlays provide existingClaim)
  - Reasonable resource requests/limits
  - `wordpressScheme: https`

### 2. Overlay: `apps/production/wordpress-micah-mmm/`

**`apps/production/wordpress-micah-mmm/kustomization.yaml`**
- References base `../../../base/wordpress`
- References `namespace.yaml`, `certificate.yaml`, `pv.yaml`
- `namespace: wordpress-micah-mmm`
- `secretGenerator` for wordpress credentials from `.env.secret.wordpress-creds.encrypted`
- Patch for HelmRelease with Micah-specific values
- Labels: `app.activescott.com/name: wordpress`, `app.activescott.com/tenant: micah`

**`apps/production/wordpress-micah-mmm/namespace.yaml`**
- Namespace `wordpress-micah-mmm`

**`apps/production/wordpress-micah-mmm/certificate.yaml`**
- cert-manager Certificate for `mmm.willeke.com`
- `issuerRef: letsencrypt-production` (ClusterIssuer)
- `secretName: mmm-willeke-com-tls`

**`apps/production/wordpress-micah-mmm/pv.yaml`**
- PV + PVC for WordPress data: hostPath `/mnt/thedatapool/app-data/wordpress-micah-mmm/wordpress`
- PV + PVC for MariaDB data: hostPath `/mnt/thedatapool/app-data/wordpress-micah-mmm/mariadb`

**`apps/production/wordpress-micah-mmm/patch-helmrelease.yaml`**
- Strategic merge patch on the HelmRelease to set:
  - `wordpressBlogName: "Micah's Blog"`
  - `wordpressUsername: micah`
  - `existingSecret` referencing the generated secret
  - `ingress.enabled: true`, `ingress.hostname: mmm.willeke.com`, `ingress.tls: true`, TLS secret reference, cert-manager annotation
  - `persistence.existingClaim` for WordPress PVC
  - `mariadb.primary.persistence.existingClaim` for MariaDB PVC

**`apps/production/wordpress-micah-mmm/.env.secret.wordpress-creds`**
- Plaintext template with `wordpress-password=CHANGE_ME` and `mariadb-root-password=CHANGE_ME` and `mariadb-password=CHANGE_ME`
- User must encrypt with SOPS (`sops --encrypt`) and save as `.env.secret.wordpress-creds.encrypted`

### 3. Wire It Up

**`apps/production/kustomization.yaml`** (edit)
- Add `./wordpress-micah-mmm` to the resources list

## Key Patterns Followed

- **Base/overlay**: Matches `apps/base/photoprism/` + `apps/production/photoprism/scott/` pattern
- **HelmRelease + HelmRepository**: Matches `apps/production/monitoring/grafana/` pattern
- **Certificate**: Matches `apps/production/monitoring/grafana/certificate.yaml` pattern
- **PV/PVC with hostPath**: Matches `apps/production/monitoring/grafana/grafana-pv.yaml` pattern
- **SOPS-encrypted secrets**: Matches all existing apps (decryption configured in `clusters/nas1/apps.yaml`)
- **Namespace per instance**: Matches `photoprism-scott`/`photoprism-oksana` pattern

## Reference Files

- `apps/production/monitoring/grafana/helmrelease.yaml` - HelmRelease pattern
- `apps/production/monitoring/grafana/grafana-pv.yaml` - PV/PVC pattern
- `apps/production/monitoring/grafana/certificate.yaml` - Certificate pattern
- `apps/production/photoprism/scott/kustomization.yaml` - Base/overlay + secrets pattern
- `infrastructure/prod/controllers/traefik/helmrepository.yaml` - HelmRepository pattern
- `clusters/nas1/apps.yaml` - SOPS decryption config

## Verification

1. Run `kustomize build apps/production/wordpress-micah-mmm/` to validate the kustomization renders correctly
2. Run `kustomize build apps/production/` to validate the full production kustomization
3. User encrypts the `.env.secret.wordpress-creds` file with SOPS before committing
4. After git push, Flux will reconcile and deploy WordPress
5. Verify DNS for `mmm.willeke.com` points to the cluster ingress IP

# Image Scanning Base

This directory contains base Kustomize resources for Flux image scanning configuration.

## Structure

- **`timestamp/`** - Base for apps using timestamp-based tagging (vYYYYMMDDHHMM format)
- **`semver/`** - Base for apps using semantic versioning

## Usage

### For Timestamp-Based Apps

Create a `kustomization.yaml` in your app's `image-scanning/` directory:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../../../bases/image-scanning/timestamp

configurations:
  - secret-name-reference.yaml  # Only if parent kustomization has configurations field

patches:
  # Customize ImageRepository
  - target:
      kind: ImageRepository
      name: repo-placeholder
    patch: |-
      - op: replace
        path: /metadata/name
        value: repo-YOUR-APP-NAME
      - op: replace
        path: /spec/image
        value: ghcr.io/YOUR-ORG/YOUR-IMAGE

  # Customize ImagePolicy
  - target:
      kind: ImagePolicy
      name: policy-placeholder
    patch: |-
      - op: replace
        path: /metadata/name
        value: policy-YOUR-APP-NAME
      - op: replace
        path: /spec/imageRepositoryRef/name
        value: repo-YOUR-APP-NAME

  # Customize ImageUpdateAutomation
  - target:
      kind: ImageUpdateAutomation
      name: update-placeholder
    patch: |-
      - op: replace
        path: /metadata/name
        value: update-YOUR-APP-NAME
```

### For Semver Apps

Same as above, but use `../../../../bases/image-scanning/semver` as the resource.

### For Apps with Multiple Images

See `apps/production/tayle/image-scanning/` for an example of handling multiple image repositories (app + worker).

## Examples

- **Timestamp**: `apps/production/coinpoet/image-scanning/`
- **Semver**: `apps/production/tayle/image-scanning/`
- **Multiple images**: `apps/production/tayle/image-scanning/`

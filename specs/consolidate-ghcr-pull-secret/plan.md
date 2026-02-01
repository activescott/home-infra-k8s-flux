# Plan: Consolidate GHCR Image Pull Secret

## Problem

The `github-container-registry-secret` is duplicated across 5 app directories. Rotating the token requires updating all 5 encrypted files manually.

## Approach

Create a shared kustomization at `apps/production/shared/ghcr-pull-secret/` containing the single `secretGenerator` and encrypted file. Each app includes it as a resource. The parent app's `namespace:` setting applies the correct namespace to the generated Secret, so each namespace still gets its own Secret — they're just all derived from one file.

## File Changes

### New Files

**`apps/production/shared/ghcr-pull-secret/kustomization.yaml`**
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
secretGenerator:
  - name: github-container-registry-secret
    type: kubernetes.io/dockerconfigjson
    files:
      - .dockerconfigjson=ghcr.dockeronfigjson.encrypted
```

**`apps/production/shared/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted`**
Copied from one of the existing 5 (they're identical).

### Modified Files

**Each of the 5 app `kustomization.yaml` files:**
1. Add `- ../shared/ghcr-pull-secret/` to `resources`
2. Remove the `github-container-registry-secret` entry from `secretGenerator`
   - For `scott-willeke-com`: remove the entire `secretGenerator:` block (only has the one entry)
   - For the other 4 apps: keep `secretGenerator:` and its other entries (db-creds, app-creds, etc.)

Files:
- `apps/production/gpupoet/kustomization.yaml`
- `apps/production/tinkerbell/kustomization.yaml`
- `apps/production/tayle/kustomization.yaml`
- `apps/production/scott-willeke-com/kustomization.yaml`
- `apps/production/ramblefeed/kustomization.yaml`

**`scripts/create-image-pull-secret-ghcr.sh`**
- Change encrypted output path from `${config_file}.encrypted` to `$repo_dir/apps/production/shared/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted`
- Update the printed instructions to reflect the new workflow (just commit and push)

### Deleted Files (from git)

- `apps/production/gpupoet/ghcr.dockeronfigjson.encrypted`
- `apps/production/tinkerbell/ghcr.dockeronfigjson.encrypted`
- `apps/production/tayle/ghcr.dockeronfigjson.encrypted`
- `apps/production/scott-willeke-com/ghcr.dockeronfigjson.encrypted`
- `apps/production/ramblefeed/ghcr.dockeronfigjson.encrypted`

### Optional Cleanup

- `.gitignore`: remove stale `scripts/ghcr.dockeronfigjson.encrypted` line
- `apps/production/gpupoet/ghcr.dockeronfigjson` (unencrypted, untracked — delete from disk)

## Why This Works

1. **Namespace scoping**: Each app's `namespace:` applies to all included resources, including the Secret from the shared sub-kustomization.
2. **File path resolution**: `secretGenerator.files` paths resolve relative to the kustomization.yaml that defines them, not the parent including it.
3. **SOPS decryption**: The encrypted file is under `apps/production/` (the Flux Kustomization path), so Flux finds and decrypts it before kustomize build.
4. **Hash suffix propagation**: Kustomize propagates generated secret names through nameReference transformers already in place.

## Verification

1. `kustomize build apps/production/gpupoet/` — verify Secret appears with correct namespace and type
2. `kustomize build apps/production/` — verify full production build succeeds
3. Run `scripts/create-image-pull-secret-ghcr.sh` — verify output lands at shared location

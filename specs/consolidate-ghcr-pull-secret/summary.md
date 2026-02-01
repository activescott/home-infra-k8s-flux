# Summary: Consolidate GHCR Image Pull Secret

## What was done

Consolidated the `github-container-registry-secret` from 5 duplicated per-app copies into a single shared kustomization.

### New files
- `apps/production/shared/ghcr-pull-secret/kustomization.yaml` — shared `secretGenerator` for the GHCR pull secret
- `apps/production/shared/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted` — single encrypted dockerconfigjson (copied from gpupoet)

### Modified files
- `apps/production/gpupoet/kustomization.yaml` — added shared resource, removed GHCR entry from `secretGenerator`
- `apps/production/tinkerbell/kustomization.yaml` — same
- `apps/production/tayle/kustomization.yaml` — same
- `apps/production/ramblefeed/kustomization.yaml` — same
- `apps/production/scott-willeke-com/kustomization.yaml` — added shared resource, removed entire `secretGenerator` block (was the only entry)
- `scripts/create-image-pull-secret-ghcr.sh` — output now writes directly to the shared location; instructions simplified to "commit and push"
- `.gitignore` — removed stale `scripts/ghcr.dockeronfigjson.encrypted` entry

### Deleted files
- `apps/production/gpupoet/ghcr.dockeronfigjson.encrypted`
- `apps/production/tinkerbell/ghcr.dockeronfigjson.encrypted`
- `apps/production/tayle/ghcr.dockeronfigjson.encrypted`
- `apps/production/scott-willeke-com/ghcr.dockeronfigjson.encrypted`
- `apps/production/ramblefeed/ghcr.dockeronfigjson.encrypted`
- `apps/production/gpupoet/ghcr.dockeronfigjson` (untracked unencrypted file, deleted from disk)

## Verification

All 5 apps verified with `kubectl kustomize`:
- Each generates the secret with the correct per-app namespace
- Secret type is `kubernetes.io/dockerconfigjson`
- Hash suffix propagates correctly to `imagePullSecrets` references in Deployments, StatefulSets, and CronJobs

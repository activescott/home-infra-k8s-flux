# Summary: Tayle Memory Leak and HPA Flapping Fix

## What was done (infra repo)

### `apps/base/tayle/app-deployment.yaml`

1. **Added `NODE_ENV=production` env var** -- plain value (not from secret), placed as the first env entry before DATABASE_URL. This ensures the Node.js runtime and frameworks (React Router, etc.) operate in production mode, reducing memory overhead from development-mode features.

2. **Increased memory limit from `1Gi` to `2Gi`** -- provides headroom during the transition period before the tayle-side fixes (shared DB pool, Dockerfile NODE_ENV) are deployed.

3. **Increased memory request from `614Mi` to `1Gi`** -- better reflects actual memory usage and prevents the scheduler from overcommitting nodes. Also stabilizes the HPA memory utilization ratio, reducing flapping.

## What remains (tayle repo)

The following changes need to be made in the tayle application repo:

1. **`apps/app/Dockerfile.prod`** -- Add `ENV NODE_ENV=production` in the production stage
2. **`apps/app/src/server-shared/database/create.ts`** -- Replace per-call `postgres()` pool creation with a lazy-init module-level singleton to eliminate connection leak

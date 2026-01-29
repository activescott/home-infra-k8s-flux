# Fix: Tayle Memory Leak and HPA Flapping

## Problem
- Node process leaks ~18.6Mi/hour of native memory (V8 heap is only 52Mi, RSS reaches 931Mi)
- HPA flaps between 1-2 replicas every ~10 minutes (282 times in 45h)

## Changes

### Fix 1: Set NODE_ENV=production

**Infra repo** -- `apps/base/tayle/app-deployment.yaml`
- Add `NODE_ENV: production` as a plain env var (not from secret)

**Tayle repo** -- `apps/app/Dockerfile.prod`
- Add `ENV NODE_ENV=production` in the production stage (after `FROM node:20` on line 22)

### Fix 2: Increase memory request/limit

**Infra repo** -- `apps/base/tayle/app-deployment.yaml`
- Memory limit: `1Gi` -> `2Gi`
- Memory request: `614Mi` -> `1Gi`
- No HPA changes needed

### Fix 3: Shared database connection pool

**Tayle repo** -- `apps/app/src/server-shared/database/create.ts`

Replace 4 functions that each create a new `postgres()` pool per call with a lazy-init module-level singleton. Then refactor each function:
- `connectDatabaseAsAuthenticatedUser(session)` -> use shared pool, keep RLS transaction logic
- `connectDatabaseAsAdmin()` -> use shared pool
- `connectDatabaseAsAdminRaw()` -> return shared pool directly
- `getRawDatabaseConnectionAsAdmin()` -> return shared client directly

## Files Modified

| File | Repo | Changes |
|------|------|---------|
| `apps/base/tayle/app-deployment.yaml` | home-infra-k8s-flux | NODE_ENV env var, memory request/limit |
| `apps/app/Dockerfile.prod` | tayle | ENV NODE_ENV=production |
| `apps/app/src/server-shared/database/create.ts` | tayle | Shared pool singleton, refactor 4 functions |

## Verification
- Deploy infra changes first (memory increase prevents OOM during transition)
- After tayle image rebuild + deploy: check `process.env.NODE_ENV === "production"`, confirm React Router loads `dist/production/` bundle
- Monitor pod RSS over time -- should stabilize well below 1Gi
- Confirm HPA stops flapping: `kubectl describe hpa app -n tayle-prod`
- Verify `pg_stat_activity` shows a stable, bounded number of connections

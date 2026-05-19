# Summary: Prometheus basic-auth → SOPS migration

## What was done

Migrated `apps/production/monitoring/prometheus/basic-auth-users` (plaintext bcrypt hash, committed in a public repo) into the SOPS-encrypted `secretGenerator` pattern already used by `alertmanager-secrets` in the same directory. Rotated the password as part of the migration since the old hash was public.

Commit: `c7013cc` — `chore(monitoring): move prometheus basic-auth into SOPS and rotate`.

### New files
- `apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth.encrypted` — SOPS-encrypted dotenv with a single `users=activescott:$2y$05$...` entry, encrypted to age recipient `age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt`.

### Modified files
- `apps/production/monitoring/prometheus/kustomization.yaml` — `prometheus-basic-auth` secretGenerator switched from `files: [users=basic-auth-users]` to `envs: [.env.secret.prometheus-basic-auth.encrypted]`. Kept `disableNameSuffixHash: true` so the resulting Secret name stays `prometheus-basic-auth` and the Traefik Middleware (`basic-auth-middleware.yaml`) needed no changes.

### Deleted files
- `apps/production/monitoring/prometheus/basic-auth-users` (plaintext bcrypt hash — content remains in git history, which is why rotation was required).

## Verification

- `kubectl kustomize apps/production/monitoring/prometheus` succeeded locally; the generated `Secret/prometheus-basic-auth` has the same structure as `Secret/alertmanager-secrets`.
- Pre-commit hook (`kubectl kustomize apps/production` + `kubectl kustomize infrastructure/prod/configs` + webhook-receiver validation) passed.
- After push, Flux's `GitRepository` reconciled to `c7013cc` within seconds (GitHub webhook receiver fired).
- `Kustomization/apps` reported `Ready: True` at revision `c7013cc`.
- `kubectl --context nas -n monitoring get secret prometheus-basic-auth -o jsonpath='{.data.users}' | base64 -d` returned the new hash, matching the one encrypted.
- Manual login at `prometheus.activescott.com` with the new password confirmed working (old password no longer accepted, by virtue of being replaced).

## Non-obvious things learned

- **macOS `htpasswd` emits `$2y$` not `$2b$`.** Both are bcrypt variants and Traefik's `basicAuth` middleware accepts either — the difference is cosmetic. No need to coerce.
- **`sops -d` on an `.encrypted` dotenv file requires `--input-type dotenv --output-type dotenv` on the CLI** because SOPS's filename-based auto-detect doesn't recognize the `.encrypted` suffix and falls back to JSON. Flux's in-cluster decryption handles this fine because the format is implied by the `secretGenerator.envs:` entry — no `.sops.yaml` config is required and there isn't one in this repo.
- The old bcrypt hash remains in git history forever; rotation is what makes that historical leakage harmless.

## Quick resume commands

```bash
# Decrypt the env file locally (note the explicit input/output types)
SOPS_AGE_KEY_FILE=$PWD/home-infra-private.agekey \
  sops -d --input-type dotenv --output-type dotenv \
    apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth.encrypted

# Verify the in-cluster Secret matches the encrypted file
kubectl --context nas -n monitoring get secret prometheus-basic-auth \
  -o jsonpath='{.data.users}' | base64 -d

# To rotate the password again, regenerate the hash and re-encrypt
htpasswd -nbB activescott "$(openssl rand -base64 24)"   # save the password!
# write users=<that line> to .env.secret.prometheus-basic-auth, then:
sops --encrypt --age age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt \
     --input-type dotenv --output-type dotenv \
     apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth \
   > apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth.encrypted
rm apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth
```

## Status

Complete. The security-review item "Migrate `apps/production/monitoring/prometheus/basic-auth-users` to SOPS" in `docs/security-review-2026-05-19.md` "Still to do" #1 can be marked done.

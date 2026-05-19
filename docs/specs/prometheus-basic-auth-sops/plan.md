# Prometheus basic-auth: migrate to SOPS-encrypted secret

Follow-up to the 2026-05-19 security review (see `docs/security-review-2026-05-19.md`). Intended as a single, self-contained commit.

## Why

`apps/production/monitoring/prometheus/basic-auth-users` is committed in plaintext on a public repo. It contains:

```
activescott:$2b$12$bblaIMqgcTHZbsrRSB/5vOVHIvRaz1CU5L30kd2RwxgVaSDd/E0Qe
```

Bcrypt is one-way, but publishing the hash in a public repo with a known username gives an attacker an unlimited offline brute-force window. The repo already uses SOPS+age for every other secret in this directory (e.g. `.env.secret.alertmanager.encrypted`); this one credential was overlooked.

Treat the existing password as compromised. Rotate as part of this migration.

## Current state

`apps/production/monitoring/prometheus/kustomization.yaml`:

```yaml
secretGenerator:
  - name: alertmanager-secrets
    options:
      disableNameSuffixHash: true
    envs:
      - .env.secret.alertmanager.encrypted   # SOPS-encrypted, the desired pattern
  - name: prometheus-basic-auth
    options:
      disableNameSuffixHash: true
    files:
      - users=basic-auth-users               # plaintext, what we're migrating
```

The Traefik `Middleware` at `apps/production/monitoring/prometheus/basic-auth-middleware.yaml:9` references `secret: prometheus-basic-auth` and reads the `users` key from it. The Secret name and key must remain the same to avoid touching the Middleware or the Ingress.

`.gitignore` already gates the file convention:

```
.env.secret*                  # blocks plaintext
!.env.*.encrypted             # allowlists encrypted
```

SOPS+age recipient (from `clusters/nas1/apps.yaml` decryption config and existing encrypted files):
`age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt`

Flux Kustomizations declare `decryption: { provider: sops, secretRef: { name: sops-age } }` in `clusters/nas1/apps.yaml`, so the in-cluster decryption is already wired up.

## Migration steps

### 1. Generate a fresh password and bcrypt hash

```bash
htpasswd -nbB activescott "$(openssl rand -base64 24)"
```

Outputs one line: `activescott:$2b$05$<hash>`.

Save the random password to a password manager — it is the only way you'll get back into Prometheus.

### 2. Write the plaintext env file (gitignored — will not be committed)

The Traefik `basicAuth` middleware expects a Kubernetes Secret with a `users` key whose value is one or more htpasswd lines. With `secretGenerator.envs:`, each line of the env file becomes a key in the Secret, so use a single `users=...` entry.

```bash
cat > apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth <<'EOF'
users=activescott:$2b$05$REPLACE_WITH_HASH_FROM_STEP_1
EOF
```

Confirm it is gitignored:

```bash
git check-ignore -v apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth
# expect: .gitignore:<line>:.env.secret*   apps/.../.env.secret.prometheus-basic-auth
```

### 3. Encrypt in place with SOPS, rename to the allowlisted extension

```bash
sops --encrypt \
     --age age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt \
     --input-type dotenv --output-type dotenv \
     apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth \
  > apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth.encrypted

rm apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth
```

Verify it can be decrypted (you'll need `home-infra-private.agekey` available, e.g. `SOPS_AGE_KEY_FILE=$PWD/home-infra-private.agekey`):

```bash
SOPS_AGE_KEY_FILE=$PWD/home-infra-private.agekey \
  sops -d apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth.encrypted
# expect: users=activescott:$2b$05$...
```

### 4. Update `kustomization.yaml`

Replace the `files:` block with `envs:` and update the entry to point at the encrypted file:

```yaml
secretGenerator:
  - name: alertmanager-secrets
    options:
      disableNameSuffixHash: true
    envs:
      - .env.secret.alertmanager.encrypted
  - name: prometheus-basic-auth
    options:
      disableNameSuffixHash: true
    envs:
      - .env.secret.prometheus-basic-auth.encrypted
```

Keep `disableNameSuffixHash: true` so the resulting Secret keeps the stable name `prometheus-basic-auth` that the Traefik Middleware references. No changes to `basic-auth-middleware.yaml` or `prometheus-ingress.yaml` are needed.

### 5. Remove the plaintext file from the tree

```bash
git rm apps/production/monitoring/prometheus/basic-auth-users
```

Note: the old hash will remain in git history. This is why step 1 (rotation) is non-optional. After the new password is live, the historical hash is for a credential that no longer exists.

### 6. Local validation

Local `kustomize build` cannot decrypt SOPS without a plugin, but you can still verify the YAML structure of everything else:

```bash
kustomize build apps/production/monitoring/prometheus 2>&1 | head -50
# Expect the build to fail at the encrypted env file or to emit a Secret stub —
# either is fine. What matters is that no other manifest errors appear.
```

To verify the in-cluster outcome after merge, watch Flux and Traefik:

```bash
flux reconcile kustomization apps -n flux-system --with-source
kubectl -n monitoring get secret prometheus-basic-auth -o jsonpath='{.data.users}' | base64 -d
# expect: activescott:$2b$05$...   (the new hash, decoded)
```

Then hit the Prometheus ingress with the new password and confirm the old password is rejected.

### 7. Commit

Suggested message:

```
chore(monitoring): move prometheus basic-auth into SOPS and rotate

Migrate apps/production/monitoring/prometheus/basic-auth-users to the
SOPS-encrypted secretGenerator pattern already used for
alertmanager-secrets in the same directory. Rotate the password as part
of the migration since the old bcrypt hash was published in the public
repo's history.
```

Files in the commit:
- `apps/production/monitoring/prometheus/.env.secret.prometheus-basic-auth.encrypted` (added)
- `apps/production/monitoring/prometheus/kustomization.yaml` (modified — `files:` → `envs:`)
- `apps/production/monitoring/prometheus/basic-auth-users` (deleted)

## Rollback

If something goes wrong post-merge and Prometheus is locked out:

```bash
# Re-create the plaintext file in-cluster as a stop-gap
kubectl -n monitoring create secret generic prometheus-basic-auth \
  --from-literal=users='activescott:$2b$05$OLD_OR_NEW_HASH' \
  --dry-run=client -o yaml | kubectl apply -f -

# Then revert the commit and let Flux reconcile back to the old state
git revert <commit-sha>
```

Flux will overwrite the manual Secret on the next reconcile, so this is only a momentary bypass while you fix forward.

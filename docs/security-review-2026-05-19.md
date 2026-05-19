# Security Review — 2026-05-19

Repository: `github.com/activescott/home-infra-k8s-flux` (public)
Reviewer: AI-assisted review of the `main` branch, current state (no PR diff).
Scope: Flux GitOps configuration, secrets handling, webhook receivers, RBAC posture, agent/bot surface. Workload application security inside the cluster (e.g. Home Assistant, Plex, Photoprism) was **out of scope**.

## Repo context (for a fresh-context reader)

- Kubernetes GitOps repo managed by Flux for the `nas1` home cluster.
- `clusters/nas1/flux-system/gotk-sync.yaml` configures a `GitRepository` pointing at `branch: main` of this repo with `interval: 1m0s`. Cluster `Kustomization` resources run with `prune: true` and Flux's `kustomize-controller`/`helm-controller` ServiceAccounts are bound to `cluster-admin` (upstream Flux default).
- Secrets are managed with **SOPS + age**. The age recipient is `age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt`. Encrypted files use suffixes `.env.*.encrypted` or `*.dockeronfigjson.encrypted`. The `.gitignore` blocks plaintext counterparts and allowlists the encrypted suffixes. The age private key lives in `home-infra-private.agekey` at the repo root and is gitignored via `*.agekey`.
- Cluster `Kustomization`s (`clusters/nas1/apps.yaml`, `clusters/nas1/infra.yaml`) reference `decryption: { provider: sops, secretRef: { name: sops-age } }`.
- No `.github/workflows/`, no CODEOWNERS, no Dependabot/Renovate. There is no CI attack surface in this repo.
- `.mcp.json` declares a Grafana MCP server with `GRAFANA_SERVICE_ACCOUNT_TOKEN: "${GRAFANA_SERVICE_ACCOUNT_TOKEN}"` (env-var substitution; no inlined secret).

## Findings

### Items verified safe and explicitly NOT flagged

- `home-infra-private.agekey` — gitignored via `.gitignore` rule `*.agekey`; absent from `git log --all --pretty=format: --name-only` across all branches/commits.
- All `.env.secret.*.encrypted` files — contain proper SOPS `ENC[AES256_GCM,...]` payloads (photoprism, webhook-token, alertmanager, etc.).
- `apps/production/shared/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted` — SOPS-encrypted.
- `apps/production/home-assistant/config-home-assistant/secrets.yaml` — only the literal HA template `some_password: welcome`, not a real secret.
- Webhook receiver (`infrastructure/base/configs/image-scanning-webhook-receiver/all.yaml`) — Flux `Receiver` of type `github` with HMAC `secretRef.name: webhook-token`; the token itself is SOPS-encrypted.
- HelmRepository URLs — all HTTPS. The only `http://` URLs in `grafana/helmrelease.yaml:41,46` reference in-cluster `*.monitoring.svc` Services, not internet traffic.
- `.claude/settings.local.json` — gitignored, not in `git ls-files`.
- `.mcp.json` — env-var substitution pattern, no inlined token.

### Items filtered as hardening (below "concrete vulnerability" bar) — operational follow-ups

These were dropped from the formal vuln report because the FP rules exclude "lack of hardening measures" without a concrete attack path, but they are real defense-in-depth gaps worth tracking:

1. **No branch protection on `main`** — recorded at review time; partial mitigation since applied (see "Actions taken"). Original concern: GitOps trust model treats anything in `main` as authoritative and Flux auto-applies within 1 minute with cluster-admin.
2. **Second collaborator (`jwilleke`) had `push`** — removed; see "Actions taken".
3. **`ImageUpdateAutomation` writes back to `main`** — `apps/base/image-scanning/semver/image-update-automation.yaml:18-19` and `apps/base/image-scanning/timestamp/image-update-automation.yaml:18-19` both set `push.branch: main`. Standard Flux pattern; only exploitable via a precondition (registry compromise or in-cluster PAT exfiltration). Recommendation: point `push.branch` at a non-`main` branch (e.g. `flux-image-updates`) and promote via PR once PR-review protection is in place.
4. **Prometheus basic-auth hash committed in plaintext** — `apps/production/monitoring/prometheus/basic-auth-users:1` (`activescott:$2b$12$...`). Bcrypt is one-way, but publishing the hash in a public repo with a known username gives unlimited offline brute-force time. Migration plan: see `docs/specs/prometheus-basic-auth-sops/plan.md`.
5. **Bootstrap GitHub PAT (classic) stored as in-cluster `flux-system` Secret** — created by `scripts/flux-bootstrap.sh`. Standard Flux bootstrap output. Long-term: migrate to a least-privilege GitHub App with rotation.

## Actions taken between review and this document

- ✅ **Removed the second collaborator** (`jwilleke`). `gh api repos/activescott/home-infra-k8s-flux/collaborators` now returns only `activescott` (admin).
- ✅ **Enabled branch protection on `main`** (no force-push, no deletions). Verified via `gh api repos/activescott/home-infra-k8s-flux/branches/main/protection`:
  ```
  "allow_force_pushes": { "enabled": false }
  "allow_deletions":    { "enabled": false }
  "required_signatures": { "enabled": false }   # intentionally — see below
  ```
  `enforce_admins.enabled` is `false`, so the admin (you) can still bypass. That is reasonable for a single-maintainer home-infra repo.

### Why `required_signatures` is intentionally OFF

Briefly enabled, then disabled on 2026-05-19 once the trade-off was understood.

Flux's `image-automation-controller` pushes commits directly to `main` as `fluxcdbot@users.noreply.github.com` (visible in `git log` — every fluxcdbot commit shows `N` for "no signature" under `git log --pretty=format:'%G?'`). Those commits are unsigned, so enabling `required_signatures` causes every Flux image-update push to be rejected by GitHub with `GH006: Protected branch update failed`. The repo's `ImageUpdateAutomation` resources (`apps/base/image-scanning/{semver,timestamp}/image-update-automation.yaml`) target `push.branch: main`, so this breaks automated image bumps repo-wide.

Making it work would require either:
- **Configuring GPG signing in `ImageUpdateAutomation.spec.git.commit.signingKey`**, storing the private key as a SOPS-encrypted Secret in `flux-system`, AND registering the public key against a GitHub identity that matches the committer email — for `fluxcdbot@users.noreply.github.com` that means standing up a real bot account, or overriding `commit.author` to the maintainer's identity. Operational overhead: managing/rotating a long-lived signing key inside the cluster, ensuring the key never expires unattended.
- **Pointing Flux pushes at a non-protected branch** (e.g. `flux-image-updates`) and promoting via PR. Conflicts with this repo's "direct push to `main`, no PRs" workflow.
- **Disabling image automation entirely.**

For a single-maintainer home-infra repo, the marginal security benefit of `required_signatures` (raising the bar from "compromise PAT" to "compromise PAT *and* signing key") was judged not worth the operational cost and the risk of silently-broken image automation. The compensating controls are: small attacker surface (one collaborator, the maintainer), no force-push, no deletions, no second pusher, and the maintainer's own commits remain signed by habit. Revisit if a second human committer is ever added.

## Still to do

In priority order:

1. **Migrate `apps/production/monitoring/prometheus/basic-auth-users` to SOPS** and rotate the password. The old hash is permanently in git history and on the public internet; treat the old password as compromised. Detailed plan in `docs/specs/prometheus-basic-auth-sops/plan.md`. Planned as a follow-up commit separate from this review.
2. **Consider enabling required PR review on `main`** (currently not set). For a solo-maintainer repo this is debatable, but it converts a single-credential compromise (PAT/SSH key) into a two-step compromise. The cost is needing to open a PR for your own changes.
3. **Consider repointing `ImageUpdateAutomation.spec.git.push.branch`** to a non-`main` branch (e.g. `flux-image-updates`) and merging to `main` via PR. Only meaningful once PR review is required.
4. **Long-term: migrate from classic PAT to a GitHub App** for the Flux bootstrap credential with least-privilege scopes and rotation.

## How to resume this work from a fresh context

- Read this file first. It supersedes any earlier ad-hoc review notes.
- Useful commands:
  ```
  # Verify branch protection state
  gh api repos/activescott/home-infra-k8s-flux/branches/main/protection

  # Verify collaborators
  gh api repos/activescott/home-infra-k8s-flux/collaborators

  # Locate every committed secret-shaped file
  git ls-files | grep -E '(secret|\.encrypted$|basic-auth|dockeronfigjson)'

  # Confirm the age private key is not in history (should print nothing)
  git log --all --pretty=format: --name-only | grep -E '\.agekey$' | sort -u

  # SOPS recipient currently in use (from any encrypted file)
  sops -d apps/production/monitoring/prometheus/.env.secret.alertmanager.encrypted
  ```
- The Prometheus basic-auth migration is the only outstanding code change. Its plan is in `docs/specs/prometheus-basic-auth-sops/plan.md`; after the migration commits, write `docs/specs/prometheus-basic-auth-sops/summary.md` per the repo's spec convention. After that commit lands, the "Still to do" item #1 above can be checked off.

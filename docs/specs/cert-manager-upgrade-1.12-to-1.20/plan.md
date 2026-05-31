# cert-manager upgrade: v1.12.0 → v1.20.2

## Context

- **Current**: cert-manager `v1.12.0`, released May 2023, LTS support ended 2025-05-19.
- **Target**: cert-manager `v1.20.2`, released 2026-04-11 (latest stable).
- **Cluster**: K3s `v1.33.5+k3s1` on node `nas`.
- **Install method**: static manifest, included via kustomize at
  `infrastructure/prod/controllers/cert-manager/base/cert-manager-manifest/kustomization.yaml`
  as a single remote URL resource.
- **Overlay**: `infrastructure/prod/controllers/cert-manager/overlays/prod/kustomization.yaml`
  patches resource limits on the three deployments using label selectors
  `app=cainjector|cert-manager|webhook` paired with
  `app.kubernetes.io/component=cainjector|controller|webhook`.

## Why upgrade

- v1.12 is EOL — no security patches.
- Two known advisories that affect 1.12:
  - **GHSA-gx3x-vq4p-mhhv** (moderate): controller DoS via crafted DNS response.
  - **GHSA-r4pg-vg54-wxx4** (low): DoS via crafted PEM input.

## Why v1.20.2 specifically

- Latest stable line; supports K8s 1.32–1.35 (we're on 1.33).
- v1.20.0 fixed a v1.19.x bug that incorrectly renewed certs when
  `issuerRef.kind`/`group` were omitted — irrelevant for us (we set
  `kind: ClusterIssuer` everywhere), but a healthier baseline.
- Has had time to soak (1.20.0 → 1.20.1 → 1.20.2 over 4 weeks).

## Compatibility audit (done before changing anything)

| Concern | Risk | Finding |
|---|---|---|
| K8s version support | Could block | K3s 1.33.5 ∈ supported range 1.32–1.35. ✅ |
| `cert-manager.io/v1alpha2/v1alpha3/v1beta1` removed in 1.16 | Cert resources fail to apply | All live `Certificate` and `ClusterIssuer` resources are already on `cert-manager.io/v1`. Repo manifests also on `v1`. ✅ |
| `issuerRef.kind` default reverted in v1.20 | Certs could resolve to wrong issuer kind | Audited every Certificate manifest under `apps/` and `infrastructure/`: all 18 explicitly set `kind: ClusterIssuer`. ✅ |
| Default container UID/GID changed (1000:0 → 65532:65532) in v1.20 | PSA/PSP block | K3s doesn't enforce restricted PSA by default; no custom security context in our overlay. Likely a no-op. Will verify pods come up. |
| Overlay label selectors `app=cert-manager` etc. | Patches fail to apply | These labels have been stable on cert-manager deployments since pre-1.12. Will dry-run with `kustomize build` before pushing. |
| `DefaultPrivateKeyRotationPolicyAlways` GA in v1.20 | Private key rotates on every renewal | Desired behavior; no action. |
| Helm-schema breaking change in v1.16 | n/a | We use static manifest, not Helm chart. ✅ |
| ACME metrics label `path` removed in v1.19 | Dashboards/alerts may break | Grafana installed; no ACME-specific dashboards configured. Low-impact. |

## Risk assessment

**Low risk.** Reasons:
- Static-manifest install — no Helm-values churn.
- All resources already on the stable `v1` API since pre-1.12.
- The repo's overlay only patches resource limits, not deployment internals.
- No in-flight CertificateRequests at audit time — all 21 certs are
  `Ready=True`, all CRs `Approved=True`.

## Rollback story

Rollback is **possible but discouraged** because cert-manager CRDs use
storage version migration when going forward; downgrading to v1.12 CRDs
would require uninstalling and reinstalling. The rollback path is:

1. `git revert <upgrade-commit>` — Flux re-applies the v1.12 manifest.
   This will downgrade the Deployment images and CRDs.
2. Existing `Secret` objects holding certificates are unaffected — TLS
   keeps working off cached secrets until expiry.
3. If anything is broken, certs continue to serve from their existing
   Secrets for up to 90 days; this is **not an outage**, only a renewal
   problem to fix forward.

## Plan

1. Audit repo for issuerRef forms (done above).
2. Capture pre-upgrade snapshot for the spec dir (not committed):
   - `kubectl get crd -o yaml` (cert-manager CRDs only)
   - `kubectl get certificates,clusterissuers,issuers -A -o yaml`
   - `kubectl get deploy -n cert-manager -o yaml`
3. Dry-run `kustomize build` against the bumped URL to confirm the
   overlay patches still apply.
4. Edit
   `infrastructure/prod/controllers/cert-manager/base/cert-manager-manifest/kustomization.yaml`:
   `v1.12.0/cert-manager.yaml` → `v1.20.2/cert-manager.yaml`.
5. Commit (signed, no AI attribution per repo policy) and push to `main`.
6. Wait for Flux reconcile (webhook auto-trigger; do not run
   `flux reconcile` per repo memory).
7. Validate:
   - All three deployments roll out cleanly (no crashloop).
   - Image tags updated to `v1.20.2`.
   - Webhook responds (`kubectl get apiservice ... v1.cert-manager.io`).
   - All existing `Certificate` resources remain `Ready=True`.
   - Controller logs are clean for ~5 minutes.
   - Issue a probe certificate against the **staging** ClusterIssuer
     and confirm it transitions to `Ready=True`, then delete it.

## Validation commands (paste-ready)

```bash
# Reconcile / rollout state
kubectl --context nas -n cert-manager get pods -o wide
kubectl --context nas -n cert-manager get deploy -o wide
kubectl --context nas get kustomizations -A | grep -i infra

# Image tags applied
kubectl --context nas -n cert-manager get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'

# CRD versions
kubectl --context nas get crd | grep cert-manager.io

# Webhook health
kubectl --context nas get apiservice v1.cert-manager.io 2>/dev/null || \
  kubectl --context nas get validatingwebhookconfiguration cert-manager-webhook -o yaml | head -30

# All certs still Ready
kubectl --context nas get certificates -A | grep -vE 'True|NAMESPACE'

# Controller logs
kubectl --context nas -n cert-manager logs deploy/cert-manager --tail=200 | grep -iE 'error|warn|fail' | head -40

# Probe cert against staging
cat <<EOF | kubectl --context nas apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: upgrade-probe
  namespace: default
spec:
  secretName: upgrade-probe-tls
  duration: 2160h
  renewBefore: 720h
  dnsNames: ["upgrade-probe.activescott.com"]
  issuerRef:
    name: letsencrypt-staging
    kind: ClusterIssuer
EOF
# ...wait for Ready=True, then delete
kubectl --context nas -n default delete certificate upgrade-probe
kubectl --context nas -n default delete secret upgrade-probe-tls --ignore-not-found
```

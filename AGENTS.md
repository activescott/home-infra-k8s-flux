# Project: home-infra-k8s-flux

Kubernetes GitOps repository managed by Flux for the `nas1` cluster.

## Flux reconciliation

Do NOT run `flux reconcile` manually after committing. GitHub webhooks
(`flux-webhook.activescott.com`) notify Flux on every push so it picks up
new commits within seconds. To watch progress after a push, use
`flux --context nas get kustomization apps` or `kubectl --context nas get
helmreleases -A` directly.

## Observability

See `apps/production/monitoring/README.md` for full architecture, chart versions, storage paths, and log collection details.

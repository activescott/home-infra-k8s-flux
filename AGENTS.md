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

Grafana dashboards under `apps/production/monitoring/grafana/dashboards/*.json` are provisioned by Flux — edits via the Grafana UI or API (including the Grafana MCP `update_dashboard` tool) get reverted on the next reconcile. To change a provisioned dashboard, edit its JSON file in this repo and commit. The Grafana API exposes `meta.provisioned: true` on these dashboards if you want to confirm before editing; the MCP `get_dashboard_by_uid` response does not currently surface that field, so when in doubt grep this repo for the dashboard UID first.

## Image sources: no Bitnami

Do not introduce `bitnami/*` runtime images or `bitnamicharts/*`
Helm charts. The public Bitnami catalog became `:latest`-only in
Aug-Sep 2025 (Broadcom moved everything else to a paid product) —
no version tags, no stable digests, silent major-version rolls.
A concrete example we hit: `bitnami/wordpress:latest` flipped from
WP 6.9.1 → 7.0.0 on the day of WP 7.0.0's release, with zero
GitOps diff. Pin by digest and you're betting on the node's local
image cache — one image GC and the pod won't restart.

Use upstream `library/*` images instead (`wordpress`, `mariadb`,
`postgres`, etc.); they have stable named version tags going back
years. Reference base for WordPress is `apps/base/wordpress-upstream/`.

Full context: see the top-level `README.md` "Image source rule"
section and `docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/`
+ `docs/specs/wordpress-micah-mmm-migrate-off-bitnami/`.

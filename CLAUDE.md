# Project: home-infra-k8s-flux

Kubernetes GitOps repository managed by Flux for the `nas1` cluster.

## Observability

See `apps/production/monitoring/README.md` for full architecture, chart versions, storage paths, and log collection details.

### Grafana MCP Server

The `.mcp.json` configures the [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana) MCP server. This provides direct access to Grafana, Loki, and Prometheus from Claude Code.

**Prerequisites:**
- `brew install mcp-grafana`
- `GRAFANA_SERVICE_ACCOUNT_TOKEN` environment variable set (Viewer role service account)

**Key tools:**
- `mcp__grafana__query_loki_logs` - run LogQL queries against Loki
- `mcp__grafana__list_loki_label_names` / `list_loki_label_values` - explore available labels
- `mcp__grafana__query_prometheus` - run PromQL queries
- `mcp__grafana__search_dashboards` - find dashboards
- `mcp__grafana__list_datasources` - list configured datasources

**Loki datasource UID:** `P8E80F9AEF21F6940`

**Common log labels:** `namespace`, `pod`, `container`, `app`, `service_name`, `level`

### Querying Loki via Port-Forward (alternative)

If the MCP server is unavailable, Loki can be queried directly (auth is disabled):
```
kubectl --context nas port-forward -n monitoring svc/loki 3100:3100
curl -sG http://localhost:3100/loki/api/v1/label/namespace/values | jq
```

# CloudflareAPIBudget

`CloudflareAPIBudgetHigh` and `CloudflareAPIBudgetCritical` (rule group
`crossplane-cloudflare-api` in `prometheus/helmrelease.yaml`) watch the same counter at
two thresholds against Cloudflare's 1200-calls-per-5-minutes token limit, so they always
diagnose the same way.

Diagnosed case so far (activescott/home-infra-k8s-flux#237): both fired together during
Ziply Fiber's planned maintenance on 2026-09-24. CoreDNS returned SERVFAIL for
`api.cloudflare.com` from 08:36Z to 08:48Z, and every failed DNS lookup made Crossplane's
provider requeue the read with error backoff instead of waiting out its normal
`--poll=15m`, so the reconcile-attempt counter climbed to 1200/5m even though essentially
zero calls reached Cloudflare. Confirm by breaking the counter down by operation:

```promql
sum by (operation) (increase(upjet_resource_ext_api_duration_count[5m]))
```

If the spike is all `operation="connect"` with `create`/`update` flat, this is the same
DNS-retry pattern, not real API usage nearing the budget -- check CoreDNS and the WAN
link (`WanGatewayDegraded.md`, `FluxReconcileErrors.md` fire from the same root cause)
before assuming Cloudflare traffic itself is the problem. Anything that doesn't match
this pattern -- `create`/`update` actually rising, or no DNS/network trouble in the same
window -- is a new failure and does mean the budget is genuinely close.

Open question from #237, not yet decided: the rule counts reconcile attempts rather than
calls that reach Cloudflare, so a DNS or network outage pages both alerts as real budget
pressure while the real budget sits unused. No rule change without Scott's decision.

## CloudflareAPIBudgetHigh

Warning tier, fires over 600 calls/5m for 5m (half the budget).

## CloudflareAPIBudgetCritical

Critical tier, fires over 1000 calls/5m for 2m (budget nearly exhausted).

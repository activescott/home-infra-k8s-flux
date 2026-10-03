# FluxReconcileErrors

`FluxReconcileErrors` (rule group `flux-system`) fires per controller
(`{{ $labels.controller }}`) on `controller_runtime_reconcile_errors_total`.

```logql
{namespace="flux-system"} |~ "i/o timeout|server misbehaving"
```

Diagnosed case so far (activescott/activeassistant#378): fired 2026-09-24 for the
`gitrepository` controller during Ziply Fiber's planned maintenance. source-controller
logged 10 errors between 08:35:18Z and 08:41:44Z trying to reach GitHub -- one
`dial tcp 140.82.116.3:443: i/o timeout`, the rest `lookup github.com on
172.17.0.10:53: server misbehaving` -- then recovered on its own, re-stored `main` and
went back to logging "no changes since last reconciliation". `WanGatewayDegraded` and
the site-probe alerts (`SiteProbeFailing.md`) fired from the same DNS/WAN outage in the
same window. The alert is a 10-minute rate window, so a genuine blip like this clears
itself; it does not need a fix unless the underlying network problem is ongoing.
Anything that doesn't match -- no DNS/network error in the named controller's logs, or
errors that don't stop once network access is restored -- is a new failure.

Unrelated findings from the same log window, worth knowing about separately: the `apps`
Kustomization had been failing its health check every 10 minutes since at least 07:00Z on
stalled Deployments, `crossplane-dns` was timing out on
`RoleMailboxes/cloudflare/activescott-com-rfc2142`, and `infra-configs` had one kustomize
build failure right as the network came back. None of those is this alert; they surfaced
only because they were in the same logs.

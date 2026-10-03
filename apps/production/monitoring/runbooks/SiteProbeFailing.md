# SiteProbeFailing

One file for the `blackbox_https` probe-failure alerts that share a subject and a triage
path: `TinkerbellbotSiteProbeFailing`, `RamblefeedSiteProbeFailing`,
`GpupoetSiteProbeFailing` (each in its own rule group, alongside that app's cert-expiry
alert) and `StalwartWebSurfaceDown` (rule group `email-stalwart`). All four watch
`probe_success{job="blackbox_https"}` for one instance; the first question for every one
of them is the same.

```promql
count(probe_success{job="blackbox_https"} == 0)
```

If that returns more than 1, every monitored site is down together and the cause is
upstream of any one app -- the WAN link or DNS, not the app, its ingress, or (for the
Cloudflare-proxied sites) Cloudflare's SSL/TLS mode. If it returns 1, the app named in
the firing alert's `instance` label is the one to chase.

Diagnosed case so far, all four (activescott/tinkerbell#197,
activescott/ramblefeed#112, activescott/gpu-poet#75, activescott/home-infra-k8s-flux#238):
every `blackbox_https` target -- fernfiles.com, gpupoet.com, tinkerbellbot.com,
ramblefeed.com, mail.activescott.com/setup, mail.activescott.com/api/health and
admin.mail.activescott.com -- dropped to `probe_success == 0` together at 2026-09-24
08:35-08:36Z and recovered together at 08:47Z, 12 minutes later, inside Ziply Fiber's
announced maintenance window. Nothing app-specific explained it: pods stayed Ready, DNS
kept resolving correctly from inside the cluster, and most failed probes returned
instantly (refused/reset) rather than timing out. `WanGatewayDegraded` and
`FluxReconcileErrors` fired from the same root cause in the same window. Anything that
doesn't match this pattern -- only one site down, or a probe returning an HTTP error
rather than a connection failure -- is a new failure and needs its own triage.

## TinkerbellbotSiteProbeFailing

## RamblefeedSiteProbeFailing

ramblefeed#112 also raised a second, unrelated finding while looking at this: the app
deployment had a pod stuck in CrashLoopBackOff for two days (ramblefeed#113). That's a
separate problem from the probe failure and doesn't explain a 12-minute outage that
recovered on its own.

## GpupoetSiteProbeFailing

## StalwartWebSurfaceDown

Three different backends share the `https://(admin\.)?mail\.activescott\.com/.*` pattern
-- admin.mail.activescott.com is Stalwart itself, `/setup` is the mail-setup nginx,
`/api/health` is the Bulwark webmail -- so check the `instance` label before assuming
it's Stalwart. If only the admin host is failing while the mail ports
(`StalwartMailPortDown`) are fine, suspect Stalwart banning the ingress controller's
address instead of the shared-outage pattern above; see
`apps/production/email-stalwart/README.md`.

# WanGatewayDegraded

`WanGatewayDegraded` and `WanGatewayDegradedBurst` (rule group `wan-link`,
`prometheus/helmrelease.yaml`) both read `loki_process_custom_wan_gateway_alarm_total`,
fed by OPNsense dpinger `MONITOR:` lines from `theshield`, at two windows: any transition
in 10 minutes (Degraded) or more than 3 in an hour (Burst, the same "dense-burst"
signature `WanLinkFlappingBurst` watches for carrier drops).

```logql
{host="theshield"} |= "MONITOR:"
```

pulls the raw dpinger lines; each `Alarm: <from> -> <to>` transition with its loss/RTT
numbers is the evidence.

## WanGatewayDegraded

Diagnosed case so far (activescott/home-infra-k8s-flux#239): fired 2026-09-24 during
Ziply Fiber's planned maintenance. The upstream gateway (`WAN_DHCP`, 50.35.64.1) alarmed
`none -> loss -> down` and was unreachable for 12m29s, then alarmed back through
`down -> loss -> none` as it recovered -- two transitions in the same 10-minute window,
which is what the rule requires. The blackbox probes for every public site
(`SiteProbeFailing.md`) and the Cloudflare API budget alerts (`CloudflareAPIBudget.md`)
fired from the same outage. It fired again 2026-09-25 on a single 40-second loss alarm
with no gateway-down transition, outside the announced maintenance window -- reopened per
#239's acceptance criteria and compared against `home-infra-private`
`docs/specs/wan-link-flapping-ziply/`. Anything with no matching `MONITOR:` transition on
`theshield` is a new failure and needs its own triage.

## WanGatewayDegradedBurst

Same counter, three-in-an-hour threshold -- the alarm equivalent of a dense-burst outage
rather than a single blip. Diagnose the same way: pull `theshield`'s `MONITOR:` lines for
the firing window and check whether the transitions cluster inside an announced Ziply
maintenance window or match a pattern already recorded in `home-infra-private`
`docs/specs/wan-link-flapping-ziply/`. If they don't, treat it as a new WAN problem
rather than a known one.

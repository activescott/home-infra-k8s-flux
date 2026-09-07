# Grafana

## Grafana major upgrades need a plugin re-pin

Grafana's Drilldown apps (Logs, Metrics, Traces, Profiles) are downloaded to
the PVC, not baked into the image, and Grafana never auto-updates a plugin
across a major version. A Grafana major upgrade therefore leaves plugin builds
behind that the new Grafana cannot load — the app renders "App not found" in
the browser while the API still reports it installed and enabled.

So when `spec.chart.spec.version` crosses a Grafana major (chart 11.x -> 13.x
carried Grafana 11 -> 13), also bump the pins in
`grafana.ini.plugins.preinstall` in the same change. Lookup and verification
commands: `../README.md`, "Step 4 (Grafana major upgrades only)".

## Dashboards

Dashboards under `dashboards/*.json` are provisioned by Flux. Edits made in the
Grafana UI or through the Grafana MCP server are reverted on the next reconcile
— change the JSON here instead.

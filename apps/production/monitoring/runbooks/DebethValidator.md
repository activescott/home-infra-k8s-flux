# DebethValidator

One file for the `debeth` alert group (activescott/activeassistant#648). debeth is Scott's
eth-docker host running a Lodestar beacon node and validator, Besu, and mev-boost. Its Alloy
remote-writes metrics to the nas Prometheus with the label `host="debeth"`; the nas has no
route into debeth.

None of these alerts had fired when this was written. Replace a section with what actually
happened the first time one does.

## Triage on debeth

There is no kubectl here. Triage runs over SSH as olya, through three read-only wrappers that
take no arguments:

```sh
ssh debeth sudo -n /usr/local/sbin/eth-logs     # last 200 lines of every eth-docker container
ssh debeth sudo -n /usr/local/sbin/eth-duties   # upcoming proposals and sync committee duty
ssh debeth sudo -n /usr/local/sbin/eth-version  # client versions
```

Never run `eth-update`, `maint-reboot`, `os-update` or `os-autoremove` from a triage turn,
even though sudo allows them. They restart the clients, and a restart at the wrong moment
misses a proposal or sync committee duty. Those are maintenance
operations Scott schedules; triage reports what it found and stops.

Do not write the validator's index or public key in an issue, a commit, or this repo. The repo
is public. Refer to it as "debeth's validator".

The Grafana dashboard **debeth** shows every series these alerts use.

## DebethMetricsAbsent

Nothing has arrived from debeth for 10 minutes, so every other alert in the group is blind.

If `ssh debeth true` fails, debeth itself is down or off the network; that is for Scott. If SSH
works, run `eth-logs` and look at the `alloy` lines: a 401 or 403 from the nas means the
remote-write credential or the Traefik IP allowlist changed, a connection error means the nas
ingress is down. Check the Traefik logs in Loki for `/api/v1/write` at the same time.

A planned OS upgrade or reboot trips this too. Check `eth-logs` timestamps for a recent
container start before treating it as an outage.

## DebethClientDown

Alloy cannot scrape the consensus or validator container. In `eth-logs`, look for the named
container exiting, restarting, or an out-of-memory kill. A client that crash-loops after an
update is the common case; say which version `eth-version` reports.

Besu is not covered here: Alloy's `execution` scrape has never succeeded, so its `up` is
always 0. A stopped Besu shows up as DebethExecutionNotSynced instead.

## DebethExporterDown

mev-boost, node-exporter or ethereum-metrics-exporter is not answering. These do not affect
the validator directly, but each blinds some alerts: ethereum-metrics-exporter feeds every
execution-layer alert, node-exporter feeds disk and clock, and DebethMetricsAbsent keys off
node-exporter. A down mev-boost does matter for proposals: Lodestar falls back to a local
block, which costs MEV rewards.

## DebethBeaconNotSynced

Lodestar is not in the Synced state, or its head is more than 8 slots behind. After a restart
it takes a few minutes to catch up. Longer than that, check `eth-logs` for the beacon node
complaining about the execution client (it cannot import blocks without Besu) and check
DebethExecutionNotSynced and DebethBeaconLowPeers.

## DebethBeaconLowPeers

Lodestar normally holds 50 to 60 peers. A drop below 20 is usually the p2p port being
unreachable from outside (a router or firewall change) or the network on debeth being down.
This is a warning; it only matters once it starts costing attestations.

## DebethExecutionNotSynced

Besu reports syncing, or its block number has not moved for 5 minutes. These come from
ethereum-metrics-exporter, not Besu's own metrics, which are not shipped. In `eth-logs`, look
at the execution lines for import errors, database corruption, or a fork it does not follow
(an outdated client after a network upgrade; compare `eth-version` with the current release).

## DebethExecutionLowPeers

Besu normally holds about 25 peers. Same causes as DebethBeaconLowPeers, on Besu's p2p port.

## DebethMissedAttestations

More than two target votes missed in an hour while the validator is otherwise running. Look
at DebethBeaconNotSynced, peers, and DebethClockUnsynced first, since a lagging head or a
drifting clock is the usual cause. One or two misses around a restart are expected and stay
under the threshold.

## DebethValidatorNotAttesting

No target vote landed on chain in 30 minutes. This is the alert that means the validator is
not doing its job. In `eth-logs`, check the validator lines for errors publishing
attestations and whether it can reach the beacon node. If both clients look healthy, the
validator may have exited or been slashed; that has no metric of its own and needs Scott to
check on a block explorer.

## DebethValidatorNotActive

The beacon node monitors no validators, or the validator client has no index. The keys were
not loaded at startup (look for keystore or doppelganger lines in `eth-logs`) or the client
cannot resolve them on chain yet. Doppelganger protection holds the validator for a few epochs
after every start, which is expected.

## DebethValidatorBeaconUnhealthy

The validator client sees its beacon node as syncing (1) or erroring (2). Check
DebethBeaconNotSynced first; if that is quiet, look for connection errors to the beacon API in
the validator lines of `eth-logs`.

## DebethDiskFull

`/` on debeth holds the chain databases and was 82% full on 2026-10-02. The warning fires at
90% and the critical at 95%. Clearing space means pruning or resizing, which are maintenance
for Scott, not triage. Report the current percentage and how fast it has been growing on the
dashboard.

## DebethClockUnsynced

The kernel reports the clock unsynchronised. Attestations are timed to the slot, so drift
turns into late votes. The dashboard shows the offset; report it and leave the NTP
configuration to Scott.

## DebethMevRelayUnreachable

Registrations to a relay are getting no HTTP response at all, usually because the relay's
hostname no longer resolves or it is down. `eth-logs` shows the mev-boost error for the relay.
The fix is changing `MEV_RELAYS` in eth-docker's `.env`, which is Scott's call.

## DebethMevRelayErrors

A relay is answering with something other than 200 or 204. A 415 on
`/eth/v1/builder/validators` means the relay rejects the registration encoding mev-boost
sends; Titan's relays did this on 2026-10-02. Like the alert above, the fix is in
`MEV_RELAYS` or a mev-boost version, and it costs MEV rewards, not proposals.

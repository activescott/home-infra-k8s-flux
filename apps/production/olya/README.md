# olya

An [OpenClaw](https://openclaw.ai) gateway, deployed as a single-replica StatefulSet.

What this is, why it is shaped the way it is, the threat model, and the runbook all live in the
private repo under `docs/specs/autonomous-ai-assistant/`. This file covers only what someone
editing these manifests needs.

## Prerequisite on the NAS

**The data directory must exist and be owned by 1000:1000 before the PV is applied.** hostPath
volumes are not chowned by the kubelet, and OpenClaw treats an unreadable state dir as a first
run and bootstraps an empty one. That failure is silent.

```bash
sudo mkdir -p /mnt/thedatapool/app-data/olya
sudo chown -R 1000:1000 /mnt/thedatapool/app-data/olya
```

## One volume, two opposite policies

The `olya` container can write some of its own volume and not the rest, and that asymmetry is the
main thing to understand before editing the StatefulSet or the scripts.

| Path               | `olya` container | Holds                                         |
| ------------------ | ---------------- | --------------------------------------------- |
| `/state/workspace` | **read-only**    | the `activeassistant` checkout: instructions, skills, subagent rules |
| `/state/config`    | **read-only**    | the live `openclaw.json` the gateway reads    |
| `/state/memory`    | read-write       | `MEMORY.md`, `DREAMS.md`, `USER.md`, `IDENTITY.md`, `memory/` |
| `/state/home`      | read-write       | `$HOME`, credentials, harness config          |
| `/state/openclaw`  | read-write       | OpenClaw state dir: SQLite, transcripts       |
| `/state/repos`     | read-write       | work repos she clones on demand               |
| `/state/archive`   | read-write       | nightly audit and transcript exports          |

**The read-only mounts are the control.** `volumeMounts[].readOnly` is per container and per
mount entry, so `seed-workspace`, `install-plugins` and `instruction-sync` write those two paths
through their own read-write `/state` mount while nothing in the `olya` container can. A write
from her tools fails with `EROFS`, which is the correct outcome. `OPENCLAW_CONFIG_READONLY=1` is
set as a second layer for a better error message, and is explicitly *not* what enforces this.

Before this existed the rule was enforced only by the boot-time `git checkout --force` plus prose
in `AGENTS.md`, which stops nothing between boots: on 2026-09-15 the live `openclaw.json` was
hand-edited from inside the container and the gateway's file-watcher crashed the pod. See
`docs/specs/olya-readonly-instructions/` and `activescott/activeassistant#71`.

The force-reset stays, and is still a control rather than a convenience — it is what makes the
15-minute `instruction-sync` converge on `origin/main` rather than fast-forward around a local
divergence. Do not replace it with a fast-forward.

Two consequences that look like bugs and are not:

- **Her working directory is not writable.** `/state/workspace` is her agent workspace *and* the
  read-only checkout. Scratch files belong in `/tmp`, `/state/repos`, or `/state/memory`.
- **The memory paths at workspace root are bind mounts** of `/state/memory`, declared on the
  `olya` container. OpenClaw reads `IDENTITY.md` and `USER.md` from workspace root, so they have
  to appear there, and they must be real files: OpenClaw refuses to read a symlinked bootstrap
  file and memory-core refuses to write a symlinked `DREAMS.md`. An earlier attempt used symlinks
  and broke both — see `docs/specs/olya-readonly-instructions/plan-memory-bind-mounts.md`.

  Two things follow. The mounts exist only in the `olya` container, so `seed-workspace`,
  `instruction-sync` and `memory-sync` all see the ordinary tracked files from the checkout;
  that is why `memory-sync` reads `/state/memory` directly rather than the workspace. And the
  files must only ever be edited in place — anything that replaces the inode under
  `/state/memory` silently decouples the two views until the pod restarts.

## Files

| File | Purpose |
| --- | --- |
| `olya-statefulset.yaml` | The gateway, one replica, two initContainers, the read-only mounts |
| `olya-memory-sync-cronjob.yaml` | Hourly commit and push of `/state/memory` |
| `olya-pv.yaml`, `olya-pvc.yaml` | One volume; see the table above for the subdirectories |
| `olya-rbac.yaml` | ServiceAccount with cluster-wide read equivalent to `view`, minus ConfigMaps |
| `olya-networkpolicy.yaml` | What she may reach on the network; default-deny both directions |
| `olya-ingress.yaml` | Certificate, Authelia ForwardAuth middleware ref, Ingress |
| `scripts/` | What the initContainers and CronJob run, as reviewable files |

## Validating the config

`openclaw.json` lives in `activescott/activeassistant`, not here — `seed-workspace` copies it out
of the checkout into `/state/config/`. OpenClaw **refuses to start** on an unknown key, a wrong
type, or an invalid value, so a typo there is a crashloop rather than a warning. Check before
committing, from a checkout of that repo:

```bash
docker run --rm \
  -v "$PWD/openclaw.json:/cfg/openclaw.json:ro" \
  -e OPENCLAW_CONFIG_PATH=/cfg/openclaw.json \
  -e OPENCLAW_GATEWAY_TOKEN=dummy -e TELEGRAM_ALLOW_FROM=1 \
  ghcr.io/activescott/olya:v0.1.0 openclaw config validate
```

Use the custom image, not the upstream one. The config points `plugins.load.paths` at `acpx` and
`diagnostics-prometheus`, which are baked into our image and absent upstream, so upstream reports
them as missing paths.

To see every available key: `openclaw config schema` (about 2.4 MB of JSON Schema).

## Kill switch

`replicas` in `olya-statefulset.yaml`. Set it to 0 and commit; Flux applies within seconds of the
webhook.

**`kubectl scale` is not the mechanism.** Flux reverts it within 10 minutes, which would look
like the assistant restarting itself.

## Things that will bite

- **`env` and `openclaw.json` must agree.** The container names each substituted key
  individually instead of using `envFrom`. Add a `${...}` to the config without adding the
  matching `secretKeyRef` and the gateway fails to start.
- **The Prometheus endpoint is authenticated.** `/api/diagnostics/prometheus` needs
  `operator.read`, so the usual `prometheus.io/scrape` pod annotation cannot work; scraping
  requires an `extraScrapeConfigs` entry with a bearer token. Not yet wired up.

# olya

An [OpenClaw](https://openclaw.ai) gateway, deployed as a single-replica StatefulSet.

What this is, why it is shaped the way it is, the threat model, and the runbook all live in the
private repo under `docs/specs/autonomous-ai-assistant/`. This file covers only what someone
editing these manifests needs.

## NOT YET ENABLED

This directory is **not** referenced from `apps/production/kustomization.yaml`, so Flux does not
reconcile it. Two things must happen first:

1. **Publish the image.** Tag `activescott/activeassistant` with `v0.1.0` to run the
   `build-image` workflow, which publishes `ghcr.io/activescott/olya:v0.1.0`. The manifests pin
   that exact tag, so without it every pod is `ImagePullBackOff`.
2. **Create the data directory on the NAS, owned by 1000:1000.** hostPath volumes are not
   chowned by the kubelet, and OpenClaw treats an unreadable state dir as a first run and
   bootstraps an empty one. That failure is silent.

   ```bash
   sudo mkdir -p /mnt/thedatapool/app-data/olya
   sudo chown -R 1000:1000 /mnt/thedatapool/app-data/olya
   ```

Then add `- ./olya` to `apps/production/kustomization.yaml` and push.

## Two directories, two opposite policies

Worth knowing before editing either initContainer, because it reads as inconsistent otherwise:

- `openclaw.json` is **declarative**. `seed-config` overwrites the copy on the volume from the
  ConfigMap on every boot, so a Control UI edit does not survive a restart.
- The agent workspace checkout is **mostly** declarative. `seed-workspace` copies the memory
  files aside, forces the checkout to `origin/main` (discarding local commits and edits, logging
  what it discarded), then restores them. So instruction files come from git and memory files
  come from the volume.

  **The force-reset is a control, not a convenience.** It is what stops an agent-written
  instruction file — a `skills/<name>/SKILL.md` in particular — from being durable and
  unreviewed. Do not replace it with a fast-forward.

## Files

| File | Purpose |
| --- | --- |
| `openclaw.json` | Gateway config. Source of truth; validated against the image (below) |
| `olya-statefulset.yaml` | The gateway, one replica, two initContainers |
| `olya-memory-sync-cronjob.yaml` | Hourly commit and push of the workspace's memory files |
| `olya-pv.yaml`, `olya-pvc.yaml` | One volume: `home/`, `openclaw/`, `workspace/`, `archive/` |
| `olya-rbac.yaml` | ServiceAccount with cluster-wide read equivalent to `view`, minus ConfigMaps |
| `olya-networkpolicy.yaml` | What she may reach on the network; default-deny both directions |
| `olya-ingress.yaml` | Certificate, Traefik basicAuth Middleware, Ingress |
| `scripts/` | What the initContainers and CronJob run, as reviewable files |

## Validating the config

OpenClaw **refuses to start** on an unknown key, a wrong type, or an invalid value, so a typo
here is a crashloop rather than a warning. Check before committing:

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

- **Secrets referenced by string.** `olya-basic-auth` sets `disableNameSuffixHash: true` because
  the Traefik Middleware names it in `spec.basicAuth.secret`, a CRD field kustomize's
  name-reference transformer does not know about. A hashed name there points at a Secret that
  does not exist, and shows up as a 401 on a correct password.
- **`env` and `openclaw.json` must agree.** The container names each substituted key
  individually instead of using `envFrom`. Add a `${...}` to the config without adding the
  matching `secretKeyRef` and the gateway fails to start.
- **The Prometheus endpoint is authenticated.** `/api/diagnostics/prometheus` needs
  `operator.read`, so the usual `prometheus.io/scrape` pod annotation cannot work; scraping
  requires an `extraScrapeConfigs` entry with a bearer token. Not yet wired up.

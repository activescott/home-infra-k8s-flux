# Home Assistant

Hardware, integrations, and general notes live in `README.md` in this
directory. This file covers only the rules an agent has to follow when
changing config here.

## Config delivery: ConfigMap vs PVC

Home Assistant's config directory is a PVC on the NAS
(`/mnt/thedatapool/app-data/home-assistant`), but **static** config files —
ones HA itself never writes — are delivered by Flux as ConfigMaps and mounted
read-only into the container.

| File | Delivery |
| --- | --- |
| `configuration.yaml` | ConfigMap `hass-configuration` |
| `template-cover-garage.yaml` | ConfigMap `hass-configuration` |
| `customize.yaml` | ConfigMap `hass-configuration` |
| `www/plugins/auto-entities/auto-entities.js` | ConfigMap `hass-www-auto-entities` |
| `automations.yaml`, `scenes.yaml`, `scripts.yaml` | PVC — HA's own UI editors write these |
| `secrets.yaml` | PVC — a secret, not ConfigMap material |

Adding a new static file means all three of: add it to `configMapGenerator` in
`kustomization.yaml`, add a mount patch for it, and add it to
`config-home-assistant/rsync-excluded-files`. Never rsync-only.

The ConfigMaps are name-hashed by kustomize, so a content change rolls the pod.
That restart is what actually delivers the file — `subPath` mounts are never
live-updated by kubelet.

**Before mounting a ConfigMap over a path that already exists on the PVC**, run
`config-home-assistant/diff-hass-and-git.sh` and commit the host's version
first. The host is the source of truth for anything HA wrote; mounting over it
without capturing it loses that content silently.

## Template entities

`configuration.yaml` must contain exactly **one** top-level template key, and
it uses the labeled form:

```yaml
template garage: !include template-cover-garage.yaml
```

More template files get their own label (`template lights: !include …`); HA
merges labeled keys. Never introduce a bare `template:` key alongside a labeled
one — the last one wins and the rest silently vanish.

Legacy `- platform: template` / `sensors:` / `covers:` syntax was **removed** in
HA 2026.6 (deprecated 2025.12). Do not reintroduce it. The garage cover broke on
the 2026.8.3 upgrade for exactly this reason.

Upstream's guidance is *not* to hand-migrate legacy templates. The garage cover
was migrated by hand because it was a single entity with no pre-existing
`template:` key; for anything larger use
[`Petro31/hass-migrate-template`](https://github.com/Petro31/hass-migrate-template)
per the [2026.6 removal
thread](https://community.home-assistant.io/t/removal-of-legacy-template-entities-in-2026-6/1011847).

Either way, gate on **Developer Tools → YAML → Check configuration** before
restarting.

## Verifying entity IDs

Config referencing a stale entity_id fails silently until something breaks. The
entity registry on the host is authoritative:

```sh
ssh scott@nas.activescott.com 'jq -r ".data.entities[] | select(.entity_id | test(\"garage\")) | [.entity_id, (.disabled_by//\"enabled\")] | @tsv" /mnt/thedatapool/app-data/home-assistant/.storage/core.entity_registry'
```

Z-Wave renames do happen — `customize.yaml` sat pointed at a
`..._access_control_window_door_is_open` entity that no longer existed.

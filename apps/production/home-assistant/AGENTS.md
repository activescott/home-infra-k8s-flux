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

## HTTP settings are UI-owned, not YAML

HA migrated `http:` out of `configuration.yaml` into UI-managed storage
(`/config/.storage/http` on the PVC, `yaml_migration_done: true`). YAML is
ignored and breaks outright in 2027.2.0. Do not re-add an `http:` key — it only
re-raises the "HTTP YAML configuration is ignored after migration" repair.
Change these at Settings > System > Network.

This is a "declare what git does not own" case (see the root `AGENTS.md`): the
UI owns the value, so git's job is to record that the setting exists, who owns
it, and what it currently is. `configuration.yaml` carries that comment, listing
`use_x_forwarded_for` and the pod-network `trusted_proxies`. **After changing
either in the UI, update that comment** or the repo stops describing reality.

### Recovering trusted_proxies when the UI is unreachable

`trusted_proxies` is the pod network CIDR (`172.16.0.0/16`), not a pod IP, so
ordinary Traefik pod churn needs no change. A cluster rebuild with a different
pod CIDR does — and it is self-locking: with `use_x_forwarded_for: true` and a
non-matching CIDR, HA answers **400** to every request arriving through the
ingress, so the UI that holds the setting cannot be reached. Verified by
`curl`: direct request → 200, same request with an untrusted
`X-Forwarded-For` → 400.

Fix it over a port-forward, which bypasses Traefik entirely — no
`X-Forwarded-For` header, so no 400 and no need to touch root-owned files:

```sh
kubectl --context nas cluster-info dump | grep -oE '(cluster-cidr|service-cidr)[^,]*'
kubectl --context nas -n home-assistant port-forward pod/home-assistant-0 8123:8123
# open http://localhost:8123 -> Settings > System > Network -> trusted proxies
```

Fallback, only if HA will not start at all (the UI is gone, not just proxied):
edit `data.stable.trusted_proxies` in the storage file on the NAS and restart
the pod. It is root-owned, so this needs `sudo`:

```sh
ssh scott@nas.activescott.com 'sudo vi /mnt/thedatapool/app-data/home-assistant/.storage/http'
kubectl --context nas -n home-assistant rollout restart statefulset/home-assistant
```

Either way, finish by updating the comment in `configuration.yaml`.

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

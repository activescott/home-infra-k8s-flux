# OlyaPodNotReady

olya-0 (namespace `olya`) has been not-Ready for 10+ minutes: the pod itself isn't Ready,
an init container is stuck in `CrashLoopBackOff`, or the pod is Pending. `CrashLoopBackOff`
is often the tail end of an `OOMKilled` init container that's now stuck retrying. Single
replica, so this is a total outage of the assistant. It's routed straight
to Scott instead of through the olya-hook receiver (`prometheus/helmrelease.yaml`) for the
obvious reason: she can't triage her own outage.

Start with the pod's own status and events:

```bash
kubectl -n olya describe pod olya-0
```

The `initContainers` section of the describe output names which of `seed-workspace`,
`prune-plugin-installs`, or `copy-workspace-creds` is stuck — check that one's logs:

```bash
kubectl -n olya logs olya-0 -c prune-plugin-installs --previous
kubectl -n olya logs olya-0 -c seed-workspace --previous
kubectl -n olya logs olya-0 -c copy-workspace-creds --previous
```

`--previous` matters here: a `CrashLoopBackOff` or `OOMKilled` container has already exited,
and the current attempt may not have logged anything yet.

## Plugins are no longer installed at boot

Every plugin is baked into the olya image (activescott/activeassistant#386), so the
`install-plugins` container, the one most often stuck here on an npm install OOMKill
(activescott/activeassistant#199, #203, #204), is gone. `prune-plugin-installs` only removes
the old install records and always exits 0, so an OOMKill there means its 1Gi limit is wrong,
not that a plugin is missing.

## Pod Pending

Means the scheduler can't place it — check node capacity and the PVC:

```bash
kubectl -n olya get events --field-selector involvedObject.name=olya-0
kubectl get pvc -n olya olya-state
```

`olya` runs on a single node (`nas`), so Pending most likely means that node is
unschedulable or out of resources, not a scheduling-preference conflict.

File the triage issue and any fix in this repo, activescott/home-infra-k8s-flux: the
StatefulSet, its init containers, and this alert rule all live here, while the image and its
plugins live in activescott/activeassistant.

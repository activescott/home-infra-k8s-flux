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
`install-plugins`, or `copy-workspace-creds` is stuck — check that one's logs:

```bash
kubectl -n olya logs olya-0 -c install-plugins --previous
kubectl -n olya logs olya-0 -c seed-workspace --previous
kubectl -n olya logs olya-0 -c copy-workspace-creds --previous
```

`--previous` matters here: a `CrashLoopBackOff` or `OOMKilled` container has already exited,
and the current attempt may not have logged anything yet.

## install-plugins is the container most likely to be stuck

It's OOMKilled or CrashLoopBackOff more than the other two, because it runs a real `npm
install` whenever the pinned plugin version doesn't match what's already on the PVC. Its
history:

- activescott/activeassistant#199: OpenClaw 2026.9.5 stopped honoring the 2026.9.4 trust
  record, so the container took the install path for the first time and OOMKilled at its
  then-256Mi limit — Node's buffered stdout on SIGKILL meant it logged nothing at all.
  Fixed by raising the limit to 1Gi and moving the plugin pin.
- activescott/activeassistant#201 (same series): the version check itself was missing —
  a mismatched pin was a no-op against an existing trust record.
- activescott/activeassistant#203: the reinstall-on-mismatch path needed `--force`, since
  `openclaw plugins install` refuses when the old version's npm dir is still on the PVC.
- activescott/activeassistant#204: the `--force` reinstall path OOMKilled at 1Gi after
  running ~5 minutes, heavier than the plain install the limit was sized for — raised to
  2Gi, which is the current limit in `apps/production/olya/olya-statefulset.yaml`.

If this fires again with `install-plugins` OOMKilled, suspect the same pattern: a new
OpenClaw major changes what counts as a trust-record match, the container takes the
`--force` reinstall path, and it needs more than 2Gi. Check `managed-plugins.txt` and
`scripts/install-plugins.mts` in `apps/production/olya/` for the current pin and install
logic before assuming a memory bump is the whole fix.

## Pod Pending

Means the scheduler can't place it — check node capacity and the PVC:

```bash
kubectl -n olya get events --field-selector involvedObject.name=olya-0
kubectl get pvc -n olya olya-state
```

`olya` runs on a single node (`nas`), so Pending most likely means that node is
unschedulable or out of resources, not a scheduling-preference conflict.

File the triage issue and any fix in this repo, activescott/home-infra-k8s-flux: the
StatefulSet, its init containers, and this alert rule all live here even though the
install-plugins fixes above landed in activescott/activeassistant.

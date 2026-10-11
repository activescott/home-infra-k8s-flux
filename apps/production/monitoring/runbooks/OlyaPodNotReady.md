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

Means the scheduler can't place it, or a volume it references can't be mounted. Check
events first, then node capacity and the PVC:

```bash
kubectl -n olya get events --field-selector involvedObject.name=olya-0
kubectl get pvc -n olya olya-state
```

A `FailedMount` event means a manifest references a ConfigMap or Secret that does not
exist. Fix the manifest, then see "Wedged single-replica StatefulSet" below, since the pod
will not recover on its own once the spec is corrected.

`olya` runs on a single node (`nas`), so Pending with no mount error most likely means that
node is unschedulable or out of resources, not a scheduling-preference conflict.

## Wedged single-replica StatefulSet

Reverting or fixing the manifest does not by itself recover a pod that's already stuck
not-Ready. A StatefulSet's RollingUpdate will not delete and replace a pod that isn't
Running and Ready, so on a single-replica StatefulSet a broken pod and a corrected spec
deadlock: the pod can never become Ready on the broken spec, and the controller won't
touch it on that basis.

Flux's own status is misleading here. Its health check times out after 5 minutes and
retries indefinitely, so `lastAppliedRevision` stays pinned to the last revision that
actually went Ready, hours old, even though the corrected spec reached the cluster
promptly. Reading that field alone looks like the fix never deployed.

Compare the pod's revision against the StatefulSet's target instead of trusting
`lastAppliedRevision`:

```bash
kubectl --context nas get sts olya -n olya -o json \
  | jq '{updateRevision:.status.updateRevision, currentRevision:.status.currentRevision}'

kubectl --context nas get pod -n olya olya-0 -o json \
  | jq '.metadata.labels."controller-revision-hash"'
```

If the pod's `controller-revision-hash` is older than the StatefulSet's `updateRevision`,
the rollout is wedged on the old pod. The fix is deleting it by hand. This is not a GitOps
violation: the desired state in git is unchanged, and deleting the pod makes the
controller converge toward the committed spec, not away from it:

```bash
kubectl --context nas delete pod -n olya olya-0
```

File the triage issue and any fix in this repo, activescott/home-infra-k8s-flux: the
StatefulSet, its init containers, and this alert rule all live here, while the image and its
plugins live in activescott/activeassistant.

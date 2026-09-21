# CrossplaneResourcesNotSynced

`CrossplaneResourcesNotSynced` fires per-GVK, not per-resource, so start with the
specific resource's own `Synced` condition message rather than the alert. Crossplane
providers generally don't send their errors to Loki, so when the condition message
alone isn't enough, check Kubernetes events instead. The alert's `namespace` label is
the provider's namespace, not the resource's: managed resources are namespaced where
they're declared, so scope to that namespace once you know it. `-A` across namespaces
is fine as a default:

```bash
kubectl -A get events --field-selector reason=CannotCreateExternalResource
```

Diagnosed case so far (activescott/home-infra-k8s-flux#186, #187): a Cloudflare API
token missing an account-level permission failed resource creation with a 403,
surfaced in the `cloudflare` namespace's events. The fix is granting that permission
on the token; #187 tracks it, blocked on Scott. File the triage issue in this repo,
Crossplane and its providers are declared here.

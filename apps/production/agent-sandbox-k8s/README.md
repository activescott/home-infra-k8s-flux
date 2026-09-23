# agent-sandbox-k8s

A virtual cluster for coding agents to run tests against, so that "bring up Postgres and the app
and check the migration" does not mean giving an agent rights on nas1
([activescott/activeassistant#346](https://github.com/activescott/activeassistant/issues/346), a
stopgap under #345 until the agent-node design in #344 exists).

Deliberately not under `apps/production/olya/`: nothing here should make olya-0 restart, and the
sandbox is meant to be deletable without touching her.

## The distro is not k3s

#346 asked for vcluster's k3s distro. vcluster deprecated it through chart 0.32 and removed it in
0.33; the chart here is 0.37.1 and `k8s` (upstream Kubernetes) is the only distro it has. A
distro cannot be changed after a vcluster is deployed, so the alternative was starting on a chart
line with no upgrade path and deleting the cluster later to get off it.

What this costs: k3s's own packaging (Traefik, ServiceLB, local-path, the single-binary
behaviour) is not what an agent gets. What it keeps: a real API server, real scheduling, real
RBAC, real pods. The distro image is pinned to `v1.33.13` to match the host's k3s minor
(v1.33.5+k3s1): the host's kubelet runs every pod the syncer creates, and a virtual API server
several minors ahead of it accepts fields the host then prunes. Raise that pin when nas1's k3s
minor moves, the same way `renovate.json5` caps `alpine/kubectl`.

## What constrains the agent

An agent holds cluster-admin inside the virtual cluster and nothing at all outside it. Everything
that limits it lives in the host namespace, where it has no rights:

| File | What it stops |
| --- | --- |
| `namespace.yaml` | Pod Security `enforce: baseline`, so no privileged pods, hostPath, hostNetwork/PID/IPC, host ports. `restricted` is warn/audit, because the vcluster control plane runs as UID 0. |
| `resourcequota.yaml` | 2 cores and 4Gi requested, 12 cores and 24Gi limited, 24 pods, 20Gi of volumes, 64Gi of ephemeral storage. NodePort and LoadBalancer Services are quota'd to zero. |
| `limitrange.yaml` | Supplies the per-container defaults the quota makes mandatory, and caps one pod at 4 cores / 8Gi / 10Gi. |
| `networkpolicy.yaml` | Default-deny both directions; out to DNS, the sandbox itself, the in-cluster registry mirror, and the public internet on 80/443. Nothing on any private network. |

Each of these applies to the host pods vcluster creates, so a virtual pod that asks for
something forbidden is rejected when the syncer creates it and stays Pending, with the reason on
the syncer's events. That is the intended failure: visible, not silent.

The quota and the LimitRange are sized against each other so they run out together. Read the
comment at the top of `resourcequota.yaml` before changing either.

## Getting the kubeconfig into olya-0

vcluster writes a kubeconfig to the Secret `vc-agent-sandbox` in this namespace. It holds a client
certificate that is cluster-admin inside the virtual cluster and carries no rights on nas1.
`exportKubeConfig.server` in `helmrelease.yaml` points it at
`https://agent-sandbox.agent-sandbox-k8s.svc.cluster.local`, so it works as-is from another pod
rather than only through `vcluster connect`.

Two things are still missing, and both belong in `apps/production/olya/` rather than here, because
changing her RBAC or her policy restarts olya-0.

She cannot read the Secret: her ServiceAccount is `view` minus ConfigMaps (`olya-rbac.yaml`), and
`view` has never included Secrets. A `Role` in this namespace naming `vc-agent-sandbox` under
`resourceNames`, bound to `system:serviceaccount:olya:olya`, is the whole grant. Keep it that
narrow, since any Secret she can read is a Secret a prompt injection can get repeated back out.

She also cannot reach the API: `olya-networkpolicy.yaml` denies all of 172.16.0.0/12 on the way
out and needs a rule to this namespace's control plane on 443. The matching ingress rule is
already in `networkpolicy.yaml` here.

## Verifying it after merge

Nothing below was run: it all needs the manifests applied, and this repo is GitOps-only.

```bash
flux --context nas get kustomization apps
kubectl --context nas -n agent-sandbox-k8s get helmrelease,pods,pvc
kubectl --context nas -n agent-sandbox-k8s get resourcequota agent-sandbox-k8s -o yaml   # used vs hard

# The kubeconfig, from a machine with cluster access (not from olya-0 until the follow-up lands):
kubectl --context nas -n agent-sandbox-k8s get secret vc-agent-sandbox -o jsonpath='{.data.config}' \
  | base64 -d > /tmp/agent-sandbox.kubeconfig
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig get ns

# Pod Security actually enforcing, from inside the virtual cluster. Expect the pod to be created
# in the vcluster and to stay Pending, with the baseline rejection on the syncer's events:
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig run privesc \
  --image=mirror.gcr.io/library/alpine:3.20 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"privesc","image":"mirror.gcr.io/library/alpine:3.20","securityContext":{"privileged":true}}]}}'
kubectl --context nas -n agent-sandbox-k8s logs -l app=vcluster --tail=50 | grep -i violat

# Egress: 443 out should work, the LAN should not.
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig run egress --rm -it \
  --image=mirror.gcr.io/library/alpine:3.20 --restart=Never -- \
  sh -c 'wget -qO- -T5 https://pypi.org/simple/ >/dev/null && echo internet-ok; \
         wget -qO- -T5 http://10.1.111.20/ ; echo "lan-exit=$?"'
```

The end-to-end proof #346 asks for (job-accelerator's Postgres plus the app, driven from olya-0)
needs the olya-side follow-up above before it can run at all.

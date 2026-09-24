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
| `resourcequota.yaml` | 2 cores and 4Gi requested, 12 cores and 24Gi limited, 24 pods, 64Gi of ephemeral storage. NodePort and LoadBalancer Services are quota'd to zero, and so are PersistentVolumeClaims beyond the control plane's own. |
| `limitrange.yaml` | Supplies the per-container defaults the quota makes mandatory, and caps one pod at 4 cores / 8Gi / 10Gi. |
| `networkpolicy.yaml` | Default-deny both directions; out to DNS, the sandbox itself, the in-cluster registry mirror, and the public internet on 80/443. Nothing on any private network. |
| `validatingadmissionpolicy.yaml` | Denies `spec.externalIPs` and `spec.loadBalancerIP` on Services, which vcluster copies to the host and kube-proxy turns into a node-wide DNAT. Requires every container an agent creates to drop ALL or NET_RAW, so it cannot ARP-spoof the pod bridge. |

Each of these applies to the host pods vcluster creates, so a virtual pod that asks for
something forbidden is rejected when the syncer creates it and stays Pending, with the reason on
the syncer's events. That is the intended failure: visible, not silent.

The quota and the LimitRange are sized against each other so they run out together. Read the
comment at the top of `resourcequota.yaml` before changing either.

Two consequences an agent writing a manifest will hit immediately. Every container needs a
`securityContext` that drops capabilities, or admission refuses it:

```yaml
securityContext:
  capabilities:
    drop: [ALL]
```

And there are no volumes: `count/persistentvolumeclaims` is the control plane's one claim and
nothing more, because local-path does not enforce a claim's size and the disk it writes to is
the one k3s runs from. Use `emptyDir`, which is bounded by the ephemeral-storage limit and
evicted by the kubelet when it is exceeded.

## What is still reachable

Egress to `0.0.0.0/0` on 80 and 443 includes this house's own public address, so anything
published through Traefik at the edge answers a sandbox pod through hairpin NAT, by its public
hostname, exactly as it answers the internet. The `except` list stops the private path, not the
public one. Same posture as `apps/production/olya/olya-networkpolicy.yaml`; the consequence is
that an app behind Traefik with weak authentication is reachable from a test workload.

## Getting the kubeconfig into olya-0

vcluster writes a kubeconfig to the Secret `vc-agent-sandbox` in this namespace. It holds a client
certificate that is cluster-admin inside the virtual cluster and carries no rights on nas1.
`exportKubeConfig.server` in `helmrelease.yaml` points it at
`https://agent-sandbox.agent-sandbox-k8s.svc.cluster.local`, so it works as-is from another pod
rather than only through `vcluster connect`.

Both halves of that now exist, and neither restarts olya-0: an RBAC grant and a NetworkPolicy
edit both take effect on the running pod, and nothing in either change touches her StatefulSet.

Reading the Secret: her ServiceAccount is `view` minus ConfigMaps (`olya-rbac.yaml`), and `view`
has never included Secrets, so `olya-kubeconfig-rbac.yaml` here adds a `Role` naming
`vc-agent-sandbox` under `resourceNames` with `get` and nothing else, bound to
`system:serviceaccount:olya:olya`. Keep it that narrow, since any Secret she can read is a Secret
a prompt injection can get repeated back out. It sits in this directory rather than under
`apps/production/olya/`, where this file first expected it, because that Kustomization sets
`namespace: olya` and would rewrite the Role out of the namespace the Secret is in, and because
deleting the sandbox should delete the grant.

Reaching the API: `olya-networkpolicy.yaml` denies all of 172.16.0.0/12 on the way out, so it
carries a rule to this namespace's control-plane pod, matching the ingress rule in
`networkpolicy.yaml` here. Both name port 8443 rather than the 443 in the kubeconfig's server
URL, because the Service maps 443 to 8443 on the pod and kube-router matches the translated
port.

## Verifying it after merge

Nothing below was run: it all needs the manifests applied, and this repo is GitOps-only.

```bash
flux --context nas get kustomization apps
kubectl --context nas -n agent-sandbox-k8s get helmrelease,pods,pvc
kubectl --context nas -n agent-sandbox-k8s get resourcequota agent-sandbox-k8s -o yaml   # used vs hard

# The kubeconfig, from a machine with cluster access:
kubectl --context nas -n agent-sandbox-k8s get secret vc-agent-sandbox -o jsonpath='{.data.config}' \
  | base64 -d > /tmp/agent-sandbox.kubeconfig
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig get ns

# The same two commands are what an agent runs from olya-0, without --context: kubectl there
# authenticates as her ServiceAccount, which the Role above lets read that one Secret.
kubectl -n agent-sandbox-k8s get secret vc-agent-sandbox -o jsonpath='{.data.config}' \
  | base64 -d > /tmp/agent-sandbox.kubeconfig
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig get ns

# Pod Security actually enforcing, from inside the virtual cluster. Expect the pod to be created
# in the vcluster and to stay Pending, with the baseline rejection on the syncer's events:
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig run privesc \
  --image=mirror.gcr.io/library/alpine:3.20 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"privesc","image":"mirror.gcr.io/library/alpine:3.20","securityContext":{"privileged":true,"capabilities":{"drop":["ALL"]}}}]}}'
kubectl --context nas -n agent-sandbox-k8s logs -l app=vcluster --tail=50 | grep -i violat

# The externalIPs denial. Expect the virtual Service to be created, the patch to it to be
# refused by agent-sandbox-k8s-service-external-ips, and the message on the syncer's events.
# The host Service exists here because it was created before the patch; what matters is that
# it never carries the field:
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig create service clusterip hijack --tcp=53:53
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig patch service hijack \
  -p '{"spec":{"externalIPs":["10.1.111.1"]}}'
kubectl --context nas -n agent-sandbox-k8s get service hijack \
  -o jsonpath='{.spec.externalIPs}{"\n"}'   # expect empty
kubectl --context nas -n agent-sandbox-k8s logs -l app=vcluster --tail=50 | grep -i externalIPs

# The capability requirement. The first pod is refused, the second runs. Both are host admission,
# so both show up on the syncer rather than in the virtual cluster:
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig run rawsock \
  --image=mirror.gcr.io/library/alpine:3.20 --restart=Never -- sleep 60

# Egress: 443 out should work, the LAN should not.
kubectl --kubeconfig /tmp/agent-sandbox.kubeconfig run egress --rm -it \
  --image=mirror.gcr.io/library/alpine:3.20 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"egress","image":"mirror.gcr.io/library/alpine:3.20","stdin":true,"tty":true,"securityContext":{"capabilities":{"drop":["ALL"]}},"command":["sh","-c","wget -qO- -T5 https://pypi.org/simple/ >/dev/null && echo internet-ok; wget -qO- -T5 http://10.1.111.20/ ; echo lan-exit=$?"]}]}}'
```

The end-to-end proof #346 asks for is hypothesis 1 below: job-accelerator's Postgres plus the
app, driven from olya-0.

## Hypotheses and how we test them

The question being answered is #345's, not this vcluster's: which of these controls hold when an
agent is root inside the thing they contain, and which a customer's security reviewer would
accept. Each claim below can fail. Results go on
[activescott/activeassistant#346](https://github.com/activescott/activeassistant/issues/346).

Only 6 could run before the olya-side grant above existed. With it applied the rest run from
olya-0.

1. An agent holding only this kubeconfig can bring up a real app with its database and run its
   tests. Deploy job-accelerator's Postgres and its app into the vcluster from olya-0, with
   `emptyDir` in place of the PVCs, then run the app's test command against that Postgres.
   Passes if the suite reaches the same result it does outside the sandbox. This decides whether
   #344's sandbox tier is worth building: a boundary nobody can work inside does not get used.

2. Pod Security and the admission policy reject every host-escape shape. From inside the
   vcluster, create four pods: privileged, hostPath, hostNetwork, and one adding NET_ADMIN. The
   `privesc` and `rawsock` commands above are the first and a pod that never drops capabilities.
   Passes if each is created in the vcluster, stays Pending with no host pod, and the rejection
   is on the syncer's events. Answers how far #344's "Kubernetes" option gets on admission alone,
   before Kata or gVisor. The other half, `SandboxPodSecurityDenied` reaching Telegram, cannot be
   tested yet: it reads the k3s audit log, which is off (`apps/production/monitoring/README.md`).

3. A Service carrying `externalIPs` or `loadBalancerIP` never reaches kube-proxy. Run the
   `hijack` commands above, then repeat the patch with `loadBalancerIP`. Passes if the virtual
   Service exists, the host Service never carries the field, and the denial names
   `agent-sandbox-k8s-service-external-ips`. Whether the host Service exists at all is down to
   ordering, and both orders pass: created with the field already set, the whole Service is
   refused at `kubectl apply`; created plain and patched afterwards, the host copy is already
   there and stays, with the patch refused and the field absent. kube-proxy installs a DNAT
   for an address that reached it, so a host Service without the field is the same result as
   no host Service. Separate from 2 because it is a node-wide traffic
   hijack needing no kernel bug, and it is what a reviewer who knows Kubernetes asks about first.
   `SandboxServiceExternalIP` is blocked on the audit log the same way.

4. Egress reaches registries and nothing private. Extend the `egress` command above with a pull
   from the in-cluster mirror and attempts at nas1's LAN address, the firewall's web UI, and the
   cluster API. Passes if the registry pull and a public 443 fetch succeed while every
   private-range attempt times out. What it cannot demonstrate is an allowlist: kube-router has
   no FQDN rules, so this is the public internet on 80 and 443 with the private ranges removed.
   That gap is the case for #344's egress proxy, and this test is how to size it.

5. The quota stops a runaway workload before another namespace notices. Scale a Deployment past
   24 replicas, each allocating memory until it is killed. Passes if the excess replicas stay
   unschedulable with a quota message, node memory pressure never fires, and nothing outside this
   namespace restarts or is evicted. Fails if a neighbour is evicted, which would mean the quota
   is sized against the numbers in `resourcequota.yaml` rather than against real headroom.

6. Falco turns a sandbox event into a Telegram message. Write a file under `/usr/bin` in a
   sandbox pod, which is the cheapest harmless match. Passes if `FalcoSandboxWarning` arrives
   with `falco_rule="Binary directory written in agent sandbox container"`. Two results that look
   like failures and are not: `kubectl exec` of a shell into a sandbox pod matches no rule on
   purpose (only Olya's namespace has one), and a pod refused at admission never starts a
   container, so Falco sees nothing and the audit alerts in 2 and 3 are what would cover it. Run
   this one first, since it needs no olya-side change and a broken pipeline looks exactly like a
   quiet cluster.

7. What this says about offering vcluster to OfB customers. Written up on #346 as two lists: what
   held, and what a customer's security reviewer would still refuse. The second already has
   entries before anything runs (the shared kernel, and egress that is not really an allowlist),
   so the output worth having is which of 1 through 5 survive contact and what joins that list.

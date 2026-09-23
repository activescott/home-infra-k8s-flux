# agent-sandbox-docker

A rootless Docker daemon for coding agents to test against, in its own namespace.
[activescott/activeassistant#347](https://github.com/activescott/activeassistant/issues/347),
part of [#345](https://github.com/activescott/activeassistant/issues/345). It is a stopgap:
[#344](https://github.com/activescott/activeassistant/issues/344) decides how the agent node
gets a real boundary, and this namespace goes away when it lands.

olya-0 reaches it at `tcp://dockerd.agent-sandbox-docker.svc.cluster.local:2376` with a client
certificate. Nothing in this pod holds a credential, has a service account token, or can reach
her namespace.

## The risk this accepts

The boundary is a shared kernel. A container that breaks out of the nested runtime lands in
this pod as uid 1000 on the node, with read/write access to olya-0's work repos at
`/state/repos` and an internet route on 80 and 443. It cannot read her credentials, push as
her, or reach anything else in the cluster or on the LAN, but it can change source she later
commits, and it can exfiltrate whatever is in those repos. Rootless mode narrows that: the
escape has to defeat the nested user namespace first, where "root" is uid 100000 and up.
Nobody should describe this as isolation in a security review. That is what #344 is for.

## The security context, and what it costs

`dockerd-deployment.yaml` carries the full reasoning next to each field. In short, three
defaults are relaxed, all for the same thing, building the user namespace RootlessKit needs:
`seccompProfile: Unconfined` (RuntimeDefault blocks `clone` with `CLONE_NEWUSER`),
`appArmorProfile: Unconfined` (the default profile denies `mount`), and
`allowPrivilegeEscalation: true` with `SETUID` and `SETGID` added back over `drop: ALL` (so the
setuid `newuidmap` and `newgidmap` helpers can write the mappings).

Not relaxed: `privileged` stays false, all four host namespaces stay at their defaults, no
`CAP_SYS_ADMIN` or `CAP_NET_ADMIN` on the node, no node Docker socket, no `/dev/fuse`, and
`procMount` stays `Default` so runc's masks over `/proc/kcore`, `/proc/sys` and the rest hold.

`procMount: Unmasked` is not available here even if it turns out to be wanted. Since the
feature went beta, Kubernetes requires `hostUsers: false` alongside it, and pod user namespaces
want a 6.3 kernel; nas1 is on 5.15.

`/dev/fuse` is not available either, and a `hostPath` mount of it will not work: runc's device
cgroup denies everything outside its fixed allowlist for an unprivileged container, so the
device node appears and every `open` on it returns `EPERM`. Getting fuse-overlayfs would take a
device plugin. That matters for the storage driver, below.

## If the daemon does not start

Read the log first: `{namespace="agent-sandbox-docker", app="dockerd"}` in Loki. In rough order
of likelihood:

`error: attempting to run rootless dockerd but need writable HOME ... and XDG_RUNTIME_DIR` is
`readOnlyRootFilesystem` biting somewhere the emptyDirs do not cover. Add the path as another
emptyDir rather than turning the read-only root off.

A `mount proc` or `operation not permitted` failure inside RootlessKit is the case that usually
gets answered with `procMount: Unmasked`, which this cluster cannot give it. The lever here is
`DOCKERD_ROOTLESS_ROOTLESSKIT_SLIRP4NETNS_SANDBOX=false` and
`DOCKERD_ROOTLESS_ROOTLESSKIT_SLIRP4NETNS_SECCOMP=false` in the container env, which stops
RootlessKit putting slirp4netns in its own mount and pid namespaces and so stops it needing a
fresh procfs.

`newuidmap: ... Permission denied`, or nested images that fail as soon as their entrypoint
switches user, means the subordinate id mapping did not happen and RootlessKit fell back to
mapping uid 1000 alone. Check that `SETUID`, `SETGID` and `allowPrivilegeEscalation: true`
survived whatever edit came before.

`Storage driver: vfs` in the startup log is not a failure, but it is slow and it will eat the
image volume: vfs copies each layer instead of stacking it. It means overlayfs refused the
backing filesystem of the `docker-data` PVC, which is whatever the local-path provisioner sits
on. The fix is to move that volume to an ext4 or xfs path, not to reach for fuse-overlayfs,
which needs the device plugin above.

Unprivileged rootless dind is not something upstream promises. `docker run --privileged` is
still what the Docker docs suggest for this image, precisely because it turns off seccomp,
AppArmor and the mount masks in one step. Everything here is an attempt to buy the first two
without the third. If it cannot be made to work, that result belongs in #344 rather than in a
`privileged: true` on this Deployment.

## TLS

cert-manager mints a private CA in this namespace, a server certificate for the Service names,
and one client certificate. No key material is in git. The image's entrypoint accepts a
pre-provisioned `/certs/server` and only verifies the chain, as long as nothing is mounted at
`/certs/ca`.

Certificates last a year and cert-manager renews them 30 days out, but dockerd reads its
certificate once at startup and has no reload, so **a renewal needs the pod restarted**. Rotating
the CA is heavier: cert-manager does not re-issue leaves when their issuer's key changes, so
both leaf Certificates have to be deleted and re-issued, and the olya-side copy redeployed.

## Egress

#347 asks for egress limited to registries. kube-router matches on CIDRs, and the registries
this needs are CDN-hosted behind address sets shared with the rest of the internet, so no
`ipBlock` expresses that. `networkpolicy.yaml` takes the two restrictions that are expressible:
every private range denied, and the public internet on 80 and 443 only.

The cluster already runs pull-through mirrors for docker.io, ghcr.io, registry.k8s.io and
mcr.microsoft.com in `apps/production/zot`. Pointing the daemon at them and then narrowing
egress to those Services is the obvious next step, and it is the mirror half of what #344 wants.
It is not done here: the mirrors need credentials that live in the zot kustomization, they cover
OCI pulls only and not the package mirrors a `docker build` reaches for, and the allowlist only
gets short once the egress proxy exists to hold the rest.

## Bind mounts

`/state/repos` is mounted at the same path olya-0 sees it at, because Docker resolves a bind
mount source on the daemon's filesystem rather than the client's: `docker run -v /state/repos/x`
and a compose file with `./:/app` in it only work if the tree is in both places at the same
path. `/state/home` is not mounted and must not be. See the comments in `volumes.yaml` for why
this is a second PersistentVolume over a subdirectory of olya's rather than a shared PVC, and
why two pods on one ReadWriteOnce volume is fine on a single node cluster.

One thing to expect: files in there are uid 1000, which is this pod's uid and the nested
namespace's root, so a nested container running as root can write them. A nested container that
drops to uid 1000 of its own maps to subordinate uid 100999 on the node and cannot. Tests that
write into a bind-mounted repo as a non-root user will hit permission errors that look nothing
like a uid mapping problem.

## Post-merge verification

Flux reconciles on push, so this is live within seconds of the merge. Nothing below changes
cluster state that git owns; it is a throwaway client pod using the client certificate that
`certificates.yaml` already issues.

```bash
kubectl --context nas -n agent-sandbox-docker get pod,certificate
kubectl --context nas -n agent-sandbox-docker logs deploy/dockerd | head -50
```

Then a client shell with the certificate mounted. The `app: docker-cli` label is what
`networkpolicy.yaml` admits; without it the connection times out.

```bash
kubectl --context nas -n agent-sandbox-docker run docker-cli -it --rm \
  --image=docker:29.8.0 --labels=app=docker-cli --restart=Never \
  --overrides='{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"docker-cli","image":"docker:29.8.0","stdin":true,"tty":true,"command":["sh"],"env":[{"name":"DOCKER_HOST","value":"tcp://dockerd.agent-sandbox-docker.svc.cluster.local:2376"},{"name":"DOCKER_TLS_VERIFY","value":"1"},{"name":"DOCKER_CERT_PATH","value":"/certs"}],"volumeMounts":[{"name":"certs","mountPath":"/certs","readOnly":true}]}],"volumes":[{"name":"certs","secret":{"secretName":"dockerd-tls-client","items":[{"key":"ca.crt","path":"ca.pem"},{"key":"tls.crt","path":"cert.pem"},{"key":"tls.key","path":"key.pem"}]}}]}}'
```

In that shell, in order, each one answering a different question:

1. `docker info` reaches the daemon over mTLS and prints the storage driver and
   `rootless: true`.
2. `docker run --rm hello-world` proves image pull and nested container start.
3. `docker run --rm -u 65534 alpine id` proves subordinate id mapping, which is the part that
   fails when `SETUID`/`SETGID` are wrong. Expect uid 65534, not an error.
4. `docker run --rm -v /state/repos:/repos:ro alpine ls /repos` proves the bind mount path.
5. A compose file: `printf 'services:\n  web:\n    image: nginx:alpine\n' > /tmp/c.yml && docker compose -f /tmp/c.yml up -d && docker compose -f /tmp/c.yml ps && docker compose -f /tmp/c.yml down`.
6. Testcontainers, which is the real acceptance test, from olya-0 once the follow-up wires
   `DOCKER_HOST` in: run the job-accelerator or fernfiles suite that starts a Postgres
   container. Testcontainers needs `TESTCONTAINERS_HOST_OVERRIDE` set to the Service name,
   because it otherwise assumes the daemon is on localhost and maps published ports there.

And confirm the two things that should fail: `docker run --rm alpine wget -qO- http://olya.olya.svc:18789/health` should time out, and so should anything on a port other than 80 or 443.

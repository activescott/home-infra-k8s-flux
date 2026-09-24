# Falco

Syscall-level runtime security for the agent sandbox namespaces
(`agent-sandbox-k8s`, `agent-sandbox-docker`) and Olya's. Added for
activescott/activeassistant#348, which is a stopgap under #345: sub-agents get to run tests
against real containers, and the compensating control is that risky operations page rather
than pass unnoticed.

Neither sandbox namespace exists yet. Every rule here matches nothing until #345 lands, which
is exactly why the verification below forces an alert instead of reading silence as success.

## Why the modern eBPF driver

nas1 runs `5.15.131+truenas`. The check that decides this is whether the kernel carries BTF:

```
$ ls -l /sys/kernel/btf/vmlinux
-r--r--r-- 1 root root 3756100 /sys/kernel/btf/vmlinux
$ head -c 4 /sys/kernel/btf/vmlinux | od -An -tx1
 9f eb 01 00
```

`0xeb9f` is the BTF magic, so the kernel is built with `CONFIG_DEBUG_INFO_BTF=y`, and 5.15 is
comfortably past the 5.8 the modern probe needs for CO-RE and the BPF ring buffer. That file
is readable from inside a pod, so this is checkable without node access.

The other two drivers are worse here for the same underlying reason. The kernel module and the
legacy eBPF probe are both compiled against the running kernel, and TrueNAS SCALE ships neither
kernel headers nor a compiler, so both would need a prebuilt driver matching the
`+truenas` kernel string. falcosecurity does not publish one, and every TrueNAS update changes
the string. The modern probe carries its own CO-RE object inside the Falco image and does not
care.

## What Falco needs to run

Worth stating plainly, since this repo is otherwise strict about what gets privilege:

Read from the rendered DaemonSet rather than from the chart's documentation, since the two do
not say quite the same thing:

- `driver.modernEbpf.leastPrivileged: true`, so the container is not privileged. It holds four
  capabilities instead: `CAP_BPF` and `CAP_PERFMON` to load and attach the probe,
  `CAP_SYS_RESOURCE` for the ring buffer's locked-memory limit, and `CAP_SYS_PTRACE` to read
  `/proc`.
- `container.apparmor.security.beta.kubernetes.io/falco: unconfined`, which the chart sets
  unconditionally.
- The host's `/proc` at `/host/proc`, writable. Falco builds its initial process table from it,
  and the chart does not mark it read-only.
- The container runtime sockets, writable: `/var/run`, `/run/containerd`, `/run/crio`,
  `/run/podman`, `/run/host-containerd`, and `/run/k3s/containerd`, which is the one that
  matters here. This is what supplies `container.*`, `k8s.ns.name` and `k8s.pod.name`.
- The host's `/etc` and `/sys/kernel`, both read-only.
- No host PID namespace and no host network. The probe sees every syscall regardless of
  namespace, and `HOST_ROOT=/host` plus the procfs mount covers the rest.

A writable containerd socket is a full escape to the node for anything that gets inside this
pod, and no amount of dropping `privileged: true` changes that. The honest summary is that
Falco can see and, if compromised, do anything on the node. That is the trade #348 accepts in
exchange for noticing a sandbox escape at all, and it is worth revisiting when #344's
agent-node design replaces this stopgap.

## Rules

The rules are in `customRules` in `helmrelease.yaml`, and they are the only rules loaded:
`falco.rules_files` lists `/etc/falco/rules.d` and nothing else. Upstream's `falco_rules.yaml`
is still fetched by falcoctl (that is how the container plugin arrives) but never read.

That is deliberate. Upstream ships around a hundred rules written for a general fleet, many of
which fire on ordinary container startup, and this change is scoped to three namespaces. The
cost is that the macros and lists the rules need are copied into the file rather than
inherited, so a change to upstream's definitions does not reach us. `falcoctl artifact follow`
is off for the same reason: rule changes should arrive through git.

Eleven rules, in three priority tiers:

| Rule | Priority | Scope |
| ---- | -------- | ----- |
| Agent sandbox container escape attempt | CRITICAL | sandboxes + olya |
| Agent sandbox privileged container started | CRITICAL | sandboxes + olya, kubelet-started containers only |
| Agent sandbox container started with a sensitive host mount | CRITICAL | sandboxes + olya, kubelet-started containers only |
| Agent sandbox container started with elevated capabilities | CRITICAL | sandboxes + olya, nested containers included |
| Agent sandbox nested container mounted a sensitive path | CRITICAL | agent-sandbox-docker |
| Kubernetes credential read in agent sandbox container | CRITICAL | sandboxes |
| Sensitive config file written in agent sandbox container | ERROR | sandboxes + olya |
| Git configuration or hook written from the Docker sandbox | ERROR | agent-sandbox-docker |
| Agent sandbox container made an unexpected private network connection | ERROR | sandboxes |
| Terminal shell in Olya's namespace | WARNING | olya |
| Binary directory written in agent sandbox container | WARNING | sandboxes + olya |

The credential-read and network rules exclude Olya's namespace on purpose: she reads her own
service account token and talks to the cluster as a matter of course, so including her would
mean an alert that fires every restart.

The one expected to need tuning is the binary-directory rule, since `make install` looks like a
dropped binary. Its tuning point is `sandbox_package_mgmt_binaries`, and the runbook says what
not to add to it.

## What the container-start rules cannot see

`container.privileged` and `container.mounts` come from the host's containerd socket, so a
process inside a container that the *sandbox* started carries the sandbox pod's metadata
rather than its own. In `agent-sandbox-docker` that means `docker run --privileged` reads as
`container.privileged=false` and `docker run -v /:/host` adds nothing to `container.mounts`.
The privileged-container and sensitive-mount rules are therefore coverage of
`agent-sandbox-k8s` and `olya` only, where the kubelet starts every container and Pod Security
rejects both shapes before one starts: a match there means admission was bypassed.

Two rules cover the nested case instead, by reading things nesting does not launder:

- `elevated capabilities` reads the capability set the kernel gave the new process.
  Docker's default set for an unprivileged container holds none of `CAP_SYS_ADMIN`,
  `CAP_SYS_MODULE`, `CAP_SYS_RAWIO` or `CAP_NET_ADMIN`; `--privileged` and
  `--cap-add=NET_ADMIN` hold them. `--cap-add=NET_ADMIN` is the precondition for the
  nf_tables privilege escalations in #347's review, and those go over netlink, so no escape
  rule would see them.
- `nested container mounted a sensitive path` reads `mount(2)` directly, where the source is
  the path as the dockerd pod sees it.

The second has a limit worth knowing before trusting it: runc 1.2 and later can do bind
mounts through `open_tree`/`move_mount`, which this kernel supports and which the driver
reports with no arguments, so a nested `-v` may take a path this rule cannot read. The
capability rule has no such dependency. Neither is a substitute for policy at the daemon: an
`--authorization-plugin` on dockerd that refuses `HostConfig.Privileged`, `CapAdd` and
non-allowlisted `Binds` is the control, and it belongs in #347.

## What the exclusions cost

`sandbox_runtime_proc` is the only exclusion the escape and capability rules have, and
anything it matches is invisible to both. It holds two absolute paths from the dind image, a
prefix match on runc's memfd self-copy, which runc re-execs before every container start and
which the kernel reports as `/memfd:runc_cloned:/proc/self/exe (deleted)`, and a glob over the
host's own runc, `/var/lib/rancher/k3s/data/*/bin/runc`.

The host's runc was added after the vcluster rollout on 2026-09-24
([activeassistant#357](https://github.com/activescott/activeassistant/issues/357)), which
raised 191 Critical matches in twenty seconds, 184 of them runc bringing up the three
containers the rollout started. #229 took the host's runtime for something Falco would not see
here, since it is not the workload. It is a container event: containerd puts runc in the
starting container's cgroup before it runs, so the plugin attributes runc's `setns`, its
`unshare`, and every rootfs path it opens to the container being built. The glob covers the
version hash in k3s's unpacked data directory, which moves with the k3s version.

Process names are not usable here and this is worth stating, because the obvious version of
this list was written that way first. `proc.name` is matched by `cp exploit /tmp/runc-x`,
`proc.cmdline` by `exec -a containerd ./exploit`, and excluding `proc.pname` excluded every
container's PID 1, because the parent of an entrypoint is `containerd-shim-runc-v2`: a pod
whose `command` was `nsenter` matched nothing at all. `proc.exepath` is the kernel's resolved
path, so matching it means being that binary.

The memfd prefix is the weak one. A process that can already exec inside a nested container
can name a memfd the same thing, so an attacker who wants their second stage unseen can have
it. Their first exec in that container has already fired the capability rule if it held any
of the four, which is the event that matters. The k3s runc glob is weak the same way and a
little worse: in `agent-sandbox-k8s` the agent writes the pod spec, so it chooses the image
and can put a file at that path. What the exclusion buys is everything runc does before the
container's entrypoint exists, and that was all of the rollout noise.

Adding to that list is a security change, not tuning. Any addition should be an absolute path
shipped in an image, and the PR should say which alert made the case.

## How this stays quiet enough to page on

One namespace has now been observed: `agent-sandbox-k8s` came up on 2026-09-24 and the rules
paged three times on it before anything ran inside (activeassistant#357). The exclusions that
came out of that are in the section above and in `helmrelease.yaml`. The rest of the claim is
still structural, and these are the four things doing the work:

- The escape and capability rules key on an event no ordinary workload produces.
  `setns`/`unshare`/`init_module` and a capability set the pod spec cannot ask for are not
  what a build or a test does.
- The terminal-shell rule is Olya's namespace only. Driving a sandbox by hand is what the
  sandboxes are for: `kubectl exec -it` and `docker exec -it` are ordinary work, an agent
  does them unprompted, and that rule is also the cheapest flood in the set (a pty in a loop
  matches as fast as it can fork). In `olya` the agents run without a tty, so a pty shell is a
  person or something wearing one.
- The credential-read rule matches host-side material and service account tokens in both
  sandboxes, with one exclusion: `/vcluster`, in `agent-sandbox-k8s`, reading the token
  projected into its own pod. The syncer authenticates to nas1 as `agent-sandbox-0`'s service
  account, so the claim that holds is the narrower one, that no workload in the sandbox reads
  a credential. #229 excluded the token path in that namespace outright on the grounds that
  anything using in-cluster config reads it; that is true of vcluster's own CoreDNS, which
  will match on the next rollout, and the answer to it is a second entry in
  `vcluster_control_plane_exepaths` rather than an open token path.
- The `/etc` rule matches a named list of files that buy persistence or a privilege change,
  not all of `/etc`. A sandbox that builds images rewrites half of `/etc` on every
  `apt-get install`.

The one rule with a known innocent match is the git-config rule: a test that runs `git init`
or `git clone` in a scratch directory writes the same files as the attack. It sits at Error
for that reason, and the runbook says how to tell them apart.

The residual risk is the other direction. If the Docker sandbox turns out to produce escape
matches through a runtime path not in the exclusion list, the rule will be noisy at Critical
on ordinary `docker run`. First thing to do when #345 lands is a `docker run` loop against the
sandbox and a count of what matched.

## Alerting

Falco writes JSON to stdout, Alloy already tails every pod, so the existing log pipeline is the
transport: no falcosidekick, no second chart, no HTTP output to configure. A `stage.match` in
`alloy/helmrelease.yaml` mints `loki_process_custom_falco_sandbox_alerts_total` from any line
at priority Warning or above and promotes `falco_rule`, `falco_priority` and `falco_ns` to
labels; the `agent-sandbox-security` group in `prometheus/helmrelease.yaml` alerts on it, and
AlertManager's default route delivers to Telegram.

The selector matches on the priority field rather than on rule names, so adding a rule here
alerts on it without touching Alloy. Two consequences of that arrangement, both of which have
bitten this repo before and are written up in `apps/production/monitoring/README.md`:

- The counter does not exist until the first match, so a broken selector and a healthy cluster
  look identical. Force a match to verify; never conclude from silence.
- Editing a `metric.counter` in Alloy needs a DaemonSet restart, not just a reload.

`FalcoNotRunning` covers the case Falco itself cannot: it reads
`kube_daemonset_status_number_unavailable`, so it fires whether Falco crashed or the
HelmRelease never produced a DaemonSet at all.

The other way to go quiet is to flood the ring buffer until the event that mattered is
dropped. `syscall_event_drops` is pinned in `helmrelease.yaml` with `alert` in its actions, so
a drop emits `Falco internal: syscall event drop` at Critical and the same selector counts it:
the attempt raises `FalcoSandboxCritical` itself, once every 30 seconds, and arrives with an
empty `falco_ns`, which is how it is recognised. Rule output is deliberately not throttled;
the comment in `helmrelease.yaml` says why a single token bucket across all rules would be a
way to hide a Critical behind a flood of Warnings.

What neither covers is the container plugin failing while Falco stays up. Every rule here is
scoped by `k8s.ns.name`, so without the plugin they all quietly match nothing. The runbook has
the query.

## Verifying it works

Both of these are harmless and both should page within a couple of minutes.

A terminal shell in Olya's pod, which is the cheapest end-to-end test of the whole path
(rule, Falco, Alloy counter, Prometheus rule, Telegram):

```bash
kubectl --context nas -n olya exec -it olya-0 -c olya -- /bin/sh -c 'echo falco-test'
```

Expect `FalcoSandboxWarning` with `falco_rule="Terminal shell in Olya's namespace"`.

A nested privileged container, which exercises the Critical tier and, more to the point, the
one case the container metadata cannot see. From a pod that holds the client certificate for
the sandbox daemon:

```bash
docker --tlsverify -H tcp://dockerd.agent-sandbox-docker:2376 run --rm --privileged alpine true
```

Expect `FalcoSandboxCritical` with
`falco_rule="Agent sandbox container started with elevated capabilities"` and a `caps` field
listing the full set. If that alert does not arrive but the same command without
`--privileged` also produces nothing, the rule is working; if neither produces anything and
Falco is up, read the exclusion list before assuming the daemon is at fault.

The rules file itself is checked with Falco's own validator rather than by watching the pod
crash-loop:

```bash
yq -r '.spec.values.customRules."agent-sandbox-rules.yaml"' helmrelease.yaml > /tmp/rules.yaml
falco --validate /tmp/rules.yaml
```

It needs the container plugin loaded, otherwise every `container.*` and `k8s.*` field in the
file is an unknown field and the result is a page of errors that say nothing about the rules.

If neither produces a Telegram message, check in this order: the log line in Loki
(`{namespace="falco"} | json`), then the counter in Prometheus
(`sum(loki_process_custom_falco_sandbox_alerts_total)`), then the Alloy metrics endpoint. The
step that is missing tells you which half is broken.

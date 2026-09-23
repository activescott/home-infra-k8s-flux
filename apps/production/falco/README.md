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

Eight rules, in three priority tiers:

| Rule | Priority | Scope |
| ---- | -------- | ----- |
| Agent sandbox container escape attempt | CRITICAL | sandboxes + olya |
| Agent sandbox privileged container started | CRITICAL | sandboxes + olya |
| Agent sandbox container started with a sensitive host mount | CRITICAL | sandboxes + olya |
| Kubernetes credential read in agent sandbox container | CRITICAL | sandboxes |
| Sensitive config file written in agent sandbox container | ERROR | sandboxes + olya |
| Agent sandbox container made an unexpected private network connection | ERROR | sandboxes |
| Terminal shell in agent sandbox container | WARNING | sandboxes + olya |
| Binary directory written in agent sandbox container | WARNING | sandboxes + olya |

The credential-read and network rules exclude Olya's namespace on purpose: she reads her own
service account token and talks to the cluster as a matter of course, so including her would
mean an alert that fires every restart.

Three of these are low-noise by construction rather than by tuning, and it is worth knowing
which lever does the work:

- The escape rule excludes the container runtimes by process name. A sandbox running a real
  Docker daemon or a k3s control plane calls `setns` constantly and re-execs runc through
  `/proc/self/exe` (which shows up as `exe`); without that list the rule is unreadable.
- The `/etc` rule matches a named list of files that buy persistence or a privilege change,
  not all of `/etc`. A sandbox that builds images rewrites half of `/etc` on every
  `apt-get install`.
- The terminal-shell rule requires a tty, which is what separates `kubectl exec -it` from the
  agent running a build step.

The one expected to need tuning is the binary-directory rule, since `make install` looks like a
dropped binary. Its tuning point is `sandbox_package_mgmt_binaries`, and the runbook says what
not to add to it.

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

## Verifying it works

Both of these are harmless and both should page within a couple of minutes.

A terminal shell in a sandbox pod, which is the cheapest end-to-end test of the whole path
(rule, Falco, Alloy counter, Prometheus rule, Telegram):

```bash
kubectl --context nas -n agent-sandbox-k8s exec -it <pod> -- /bin/sh -c 'echo falco-test'
```

Expect `FalcoSandboxWarning` with `falco_rule="Terminal shell in agent sandbox container"`.

A credential read, which exercises the Critical tier:

```bash
kubectl --context nas -n agent-sandbox-k8s exec <pod> -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/token
```

Expect `FalcoSandboxCritical`. If the sandbox pod has no token mounted, which is what it should
look like, this returns nothing and does not alert, and that is the right answer.

If neither produces a Telegram message, check in this order: the log line in Loki
(`{namespace="falco"} | json`), then the counter in Prometheus
(`sum(loki_process_custom_falco_sandbox_alerts_total)`), then the Alloy metrics endpoint. The
step that is missing tells you which half is broken.

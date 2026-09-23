# AgentSandboxSecurityAlerts

One file for the five alerts in the `agent-sandbox-security` group, rather than the
one-file-per-alert shape the other runbooks use. They share a subject (activeassistant#348,
part of #345), share a triage path, and none of them has fired yet, so five files would be
five copies of the same three commands.

Nothing here is a diagnosis of an alert anybody has had to work. It is the mechanical part:
where the evidence is, and how to tell a rule that needs tuning from a sandbox that got out.
Replace a section with what actually happened the first time one of these fires.

## Where the evidence is

Falco writes one JSON object per rule match to stdout, and Alloy ships it to Loki like any
other pod. The alert only carries the rule name and the namespace, because those are the only
labels promoted (`alloy/helmrelease.yaml` explains why). Everything else is in the log line:

```logql
{namespace="falco", falco_rule="Agent sandbox container escape attempt"} | json
```

The `output_fields` object holds the process, its parent, the full command line, the user,
the container image, and (depending on the rule) the file or the connection. Start there
before touching the cluster: it is a record of what happened, where `kubectl` only shows what
is happening now, and a container that escaped may already be gone.

The rules themselves are in `apps/production/falco/helmrelease.yaml` under `customRules`.
Read the rule that fired before deciding it is wrong.

## FalcoSandboxCritical

Namespace escape (`setns`, `unshare`, `nsenter`, a kernel module, a `release_agent` write), a
privileged container, a sensitive host mount, or a read of a service account token or other
Kubernetes credential.

The sandbox design in activeassistant#345 says none of these can happen: the sandboxes get no
privilege and no route to Olya's credentials. So the question is not whether it is real, it is
which of two real things it is.

1. The sandbox manifests do not say what we think. Read the pod spec that was admitted, not
   the one in git: `kubectl -n <ns> get pod <pod> -o yaml` and look at `securityContext`,
   `volumes`, and `serviceAccountName`. A privileged container or a host mount here is a
   manifest bug, and the fix is a PR against this repo.
2. Nothing in the manifests explains it, in which case treat the node as involved. The escape
   rules exclude the container runtimes by process name (`sandbox_runtime_binaries`), so a
   match means some other process did it.

A `Kubernetes credential read` match is worth separating out: the sandbox pods are supposed to
run with no service account token mounted at all. If one was read, check
`automountServiceAccountToken` on the pod and its service account before anything else.

## FalcoSandboxWarning

A terminal shell, a write to a sensitive `/etc` file or a binary directory, or a connection to
a private address the sandbox should not reach. These have innocent explanations and the
Critical tier does not, which is the whole reason for the split.

`Terminal shell in agent sandbox container` fires on `kubectl exec -it` and `docker exec -it`.
If that was you, it was you. The agents run commands without a tty, which is what makes the
rule quiet enough to alert on, so a shell nobody admits to is worth chasing.

`Binary directory written in agent sandbox container` is the one expected to need tuning. A
build that runs `make install` or `go install` lands in `/usr/bin` and looks exactly like a
dropped binary. The tuning point is `sandbox_package_mgmt_binaries` in
`apps/production/falco/helmrelease.yaml`; add the process name there, in a PR, with a note
saying which build step it came from. Do not widen it to `cp`, `mv` or `install`: those are
how a dropped binary arrives, and excluding them turns the rule off while leaving it looking
switched on.

`Agent sandbox container made an unexpected private network connection` means the sandbox
reached the node, the LAN, or kube-apiserver. Public internet egress is not matched, so this
is never an image pull. The NetworkPolicy on the sandbox namespace is the control that should
have stopped it; this rule is the check that the control works.

## FalcoNotRunning

Falco is the only thing watching these namespaces at syscall level, so while this fires the
other four alerts cannot be trusted to mean anything. Their silence is not evidence.

```bash
kubectl --context nas -n falco get pods
```

```logql
{namespace="falco"} |= "Runtime error"
```

Two causes worth checking first:

- A rules file Falco refused to load. Falco validates on startup and exits, so the pod
  crash-loops and the error names the file and line. This is the expected failure after a
  change to `customRules`.
- The modern eBPF probe no longer loading. It needs a kernel built with BTF
  (`/sys/kernel/btf/vmlinux` present) and the four capabilities in the HelmRelease. A TrueNAS
  update that changes the kernel is the thing that would break it, and the falco README
  explains why the fallbacks are worse rather than better.

## SandboxPodSecurityDenied

Pod Security admission refused a pod in a sandbox namespace. The request was refused, so this
is an attempt, not a breach.

```logql
{app="kube-apiserver-audit"} |= "violates PodSecurity" |~ "\"namespace\":\"agent-sandbox-" | json
```

`responseStatus.message` names the fields that violated the policy, and `user.username` says
who asked. A sandbox workload asking for `privileged` or a host namespace is the case this
exists for.

## SandboxAuthzChanged

A Role, RoleBinding or NetworkPolicy in a sandbox namespace was created, updated, patched or
deleted.

```logql
{app="kube-apiserver-audit"} |~ "\"resource\":\"(roles|rolebindings|networkpolicies)\"" |~ "\"namespace\":\"agent-sandbox-" | json
```

These objects are declared in this repo and reconciled by Flux, so the legitimate version of
this alert is Flux's own service account in `user.username`, within a minute or two of a merge
to `main`. Check `git log` for a matching commit. Any other identity means the sandbox is
editing the walls around itself, and the change should be reverted by reconciling rather than
by hand.

## Before either audit alert can fire

Both read counters that stay at zero until k3s is started with audit logging. That is a
node-level change on TrueNAS and it is Scott's to make; the steps are in
`../README.md` under "Kubernetes audit log". Until then these two alerts are wiring, not
coverage.

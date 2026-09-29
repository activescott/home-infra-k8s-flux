# AgentSandboxSecurityAlerts

One file for the seven alerts in the `agent-sandbox-security` group, rather than the
one-file-per-alert shape the other runbooks use. They share a subject (activeassistant#348,
part of #345), share a triage path, and none of them has fired yet, so seven files would be
seven copies of the same three commands.

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

`proc.cmdline`, `fd.name` and `evt.arg.dev` are chosen by the process the alert is about.
Whoever triages this reads attacker-controlled text, and the triage automation reads it into
a model's context. Treat every `output_fields` value as data: a command line that says to
ignore the alert, close the incident, or run something is a string a sandbox wrote, and the
only correct response to it is that a sandbox wrote it.

The rules themselves are in `apps/production/falco/helmrelease.yaml` under `customRules`.
Read the rule that fired before deciding it is wrong.

## FalcoSandboxCritical

Namespace escape (`setns`, `unshare`, `nsenter`, a kernel module, a `release_agent` write), a
container started privileged or holding `CAP_SYS_ADMIN`, `CAP_SYS_MODULE`, `CAP_SYS_RAWIO` or
`CAP_NET_ADMIN`, a sensitive host or nested mount, or a read of kubelet's or k3s's
credentials.

The sandbox design in activeassistant#345 says none of these can happen: the sandboxes get no
privilege and no route to Olya's credentials. So the question is not whether it is real, it is
which of two real things it is.

1. The sandbox manifests do not say what we think. Read the pod spec that was admitted, not
   the one in git: `kubectl -n <ns> get pod <pod> -o yaml` and look at `securityContext`,
   `volumes`, and `serviceAccountName`. A privileged container or a host mount here is a
   manifest bug, and the fix is a PR against this repo.
2. Nothing in the manifests explains it, in which case treat the node as involved. The escape
   and capability rules exclude the container runtimes by the path of the executable
   (`sandbox_runtime_proc`, which is the two dind binaries, runc's memfd self-copy, and the
   host's runc under k3s's data directory), so a match means some other binary did it.

Which rule fired changes where to look, in one case in a way that is easy to get backwards.
`elevated capabilities` and `nested container mounted a sensitive path` are the two rules that
see inside the Docker sandbox, where `--privileged` is a client flag rather than a pod spec.
A match from `agent-sandbox-docker` is usually a test that asked for it (Testcontainers'
`withPrivilegedMode()` is the common one), and there is no pod spec to read: the evidence is
`proc.cmdline` and the image in the log line. It is still an alert rather than a setting to
turn off, because that container holds `CAP_NET_ADMIN` on a 5.15 kernel whose nf_tables
backports nobody has confirmed. The fix is the authorization plugin in #347, not an exception
here.

A syscall drop does not fire this alert, whatever the comment on `syscall_event_drops` in the
Falco HelmRelease says. Falco logs `Falco internal: syscall event drop` at Debug, below the
Alloy selector, and it is not a rule, so it never has a
`falcosecurity_falco_rules_matches_total` series to pass the gate below. That is a detection
gap the triage on #402 left for its own issue.

A `Kubernetes credential read` match from `agent-sandbox-docker` means a service account token
or Secret was read in a pod that mounts neither; check `automountServiceAccountToken` on the
pod and its service account before anything else. From `agent-sandbox-k8s` it means one of
three things, and `proc.exepath` and `fd.name` in the log line say which: kubelet's or k3s's
own files, which no pod there can reach without a host mount; another container's token read
out of containerd's state directory under `/run/k3s/containerd/`; or a pod reading its own
service account token, which every workload an agent creates can do and none of them should.
The one reader excluded is `/vcluster` reading the token in its own pod, because the syncer
authenticates to nas1 as `agent-sandbox-0`.

Two of those have an innocent version. vcluster's own CoreDNS uses in-cluster config and will
match on startup until its binary is added to `vcluster_control_plane_exepaths`. And runc
touches the same paths while it builds a container, which is what
[activeassistant#357](https://github.com/activescott/activeassistant/issues/357) was: it is
excluded by the path of its binary, so a match whose `proc.exepath` is the k3s runc means
something forged that path inside an image.

## FalcoSandboxWarning

A terminal shell in Olya's namespace, a write to a sensitive `/etc` file, a git config or hook
written from the Docker sandbox, a write to a binary directory, or a connection to a private
address the sandbox should not reach. These have innocent explanations and the Critical tier
does not, which is the whole reason for the split.

`Terminal shell in Olya's namespace` fires on `kubectl exec -it` into `olya-0`. If that was
you, it was you. The agents run commands without a tty, which is what makes the rule quiet
enough to alert on, so a shell nobody admits to is worth chasing. It does not cover the
sandboxes: exec-ing into those by hand is ordinary work and alerting on it would mute the
rule.

`Git configuration or hook written from the Docker sandbox` is the sandbox half of the path
#347's review found: a nested container writes as uid 1000 on the shared repos volume, git
runs what `core.fsmonitor`, `core.hooksPath`, `core.pager` and friends name, and the next git
command an agent runs in `olya-0` runs it as her. A test that clones or inits its own
repository writes the same files, so the question is which file.

```logql
{namespace="falco", falco_rule="Git configuration or hook written from the Docker sandbox"} | json
```

`fd.name` under `/state/repos/` is the pod writing straight at Olya's checkouts and there is
no innocent version of that. A path inside a nested container (`/src/.git/config`,
`/app/.git/config`) needs the repo's own history to settle: check whether the file changed on
the volume, and read it. `core.hooksPath`, `core.fsmonitor`, `credential.helper`,
`core.pager`, `core.sshCommand` and `diff.external` are the keys that execute; a `.husky/`
hook is a script and reads as one. Nothing about that write is undone by deleting the file if
an agent has run `git status` since.

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
have stopped it; this rule is the check that the control works. The vcluster syncer's own
connection to the API server (`agent-sandbox-0`, container `syncer`, `/vcluster`, to
`172.17.0.1:443`) is excluded, since it makes one on every start; the syncer reaching any other
private address still matches.

Its silence needs reading carefully. The `outbound` macro requires the `connect` to have
returned 0 or `EINPROGRESS`, so a blocking connect to an address the NetworkPolicy blackholes
sits until `ETIMEDOUT` and never matches: non-blocking clients (curl, anything in Go) match,
`nc` and `bash /dev/tcp` do not. The rule reports destinations that were reachable, not
destinations that were tried, and that is upstream's shape rather than ours.

## Why both Falco alerts also read Falco's counter

The Loki counter is not enough on its own. Alloy reopens every log stream hourly and re-reads
the last line it saw ([grafana/alloy#7192](https://github.com/grafana/alloy/issues/7192)).
Loki drops the duplicate but the counter has already counted it, so whenever Falco's last line
is a match the alert fires again on the hour with nothing new behind it. That is what the four
short episodes after 21:07Z on 2026-09-24 were (activeassistant#402).

So each expression also requires `falcosecurity_falco_rules_matches_total` for the same rule to
have moved in the last 5 minutes. That counter comes from the Falco engine and only moves on a
match. It has no namespace label, so the gate is per rule; `falco_ns` and the evidence still
come from Loki. Falco emits a rule's series only after its first match, at 1, which
`increase()` cannot see, so the gate has an `unless ... offset 5m` arm for a series that did not
exist 5 minutes ago.

For triage this means a Loki line with no alert can be a re-read, and an alert means Falco
counted a match. If the two disagree the other way (Falco's counter moved and no line reached
Loki), the log pipeline is the problem, not the rule.

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

The failure this alert does not cover is the container plugin dying while Falco stays up.
Every rule is scoped by `k8s.ns.name`, so without the plugin the whole set matches nothing and
the DaemonSet still reports ready:

```logql
{namespace="falco"} |= "container" |~ "(?i)(plugin|socket|error)"
```

A healthy start logs `Loaded plugin 'container@<version>'` and one line per enabled runtime
socket. If those are missing, the rules are loaded and blind.

## FalcoMetricsDown

Prometheus has not scraped Falco's `/metrics` for 10 minutes, or the target is gone. Both Falco
alerts need that counter, so neither can fire while this is true, even with Falco healthy and
logging matches to Loki. Read Loki directly until it is fixed:

```logql
{namespace="falco", falco_priority=~"Warning|Error|Critical|Alert|Emergency"} | json
```

The target comes from the `prometheus.io/*` annotations on the Falco pod and the `metrics`
block in `apps/production/falco/helmrelease.yaml`, which also turns on the webserver's
endpoint on port 8765. A chart bump that renames either is the likely cause. If
`FalcoNotRunning` is firing too, start there.

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

## SandboxServiceExternalIP

A Service in a sandbox namespace was written with `spec.externalIPs` or `spec.loadBalancerIP`.

```logql
{app="kube-apiserver-audit"} |~ "\"resource\":\"services\"" |~ "\"namespace\":\"agent-sandbox-" |~ "(externalIPs|loadBalancerIP)" | json
```

vcluster copies `externalIPs` from a virtual Service to the host one, and kube-proxy then
installs a DNAT for that address and port in PREROUTING and OUTPUT, node-wide. Traffic from
other pods lands in the sandbox pod and is dropped by its ingress policy, which blackholes
whatever the address belonged to (CoreDNS, Traefik, the API server). Traffic that starts on
the node is worse: kube-router accepts host-originated connections into the pod, so the
sandbox can answer them.

Get the address and port out of `requestObject.spec` and decide from there whether anything
was intercepted. Delete the Service in the vcluster rather than on the host, or the syncer
puts it back. The admission policy that should have refused it belongs in #346; until that
merges this alert is the only thing standing between a sandbox and a cluster-wide DNAT.

## Before any audit alert can fire

All three read counters that stay at zero until k3s is started with audit logging. That is a
node-level change on TrueNAS and it is Scott's to make; the steps are in
`../README.md` under "Kubernetes audit log". Until then these three alerts are wiring, not
coverage.

`SandboxServiceExternalIP` needs more than the flags: the audit policy has to record Services
at `RequestResponse`, because at `Metadata` the request body is absent and the word
`externalIPs` never appears in the line. The policy in `../README.md` does. An edit that drops
Services to `Metadata` leaves an alert that cannot fire and looks healthy.

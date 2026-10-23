# agents-jump

An sshd that Scott, Olya and Alex use to reach the assistant VMs on debprime over SSH from anywhere (ping-poet/dreamwright#1414). It is a stripped-down [../jumpbox](../jumpbox): that one admits only the Dreamwright agents host and gives read-only `kubectl`, this one admits any source address and gives nothing but ProxyJump.

It accepts one user, `abc`, with a key from [authorized_keys](authorized_keys), each line commented with whose it is. A session gets no shell, command or sftp (`ForceCommand /bin/false`, `PermitTTY no`); the only thing a key can do is open a TCP forward to one of the `PermitOpen` destinations in [sshd_config](sshd_config):

| VM         | Address        |
| ---------- | -------------- |
| dw-alex    | 10.1.111.30:22 |
| dw-robin   | 10.1.111.31:22 |
| dw-lindsay | 10.1.111.32:22 |
| dw-eric    | 10.1.111.33:22 |
| dw-buster  | 10.1.111.34:22 |

## Threat model

- The sshd faces the whole internet, so the defence is key-only auth (ed25519 public keys, no passwords, no keyboard-interactive, no root) and limits on unauthenticated connections (`MaxAuthTries`, `LoginGraceTime`, `MaxStartups`).
- A stolen key reaches the VMs' sshd and nothing else: `PermitOpen` and the NetworkPolicy both allow only those four addresses on port 22, there is no shell in the pod to pivot from, and the pod has no ServiceAccount token or DNS. Logging into a VM still needs that VM's own key.
- An sshd vulnerability gives code execution as uid 911 in a read-only container with no capabilities, still behind the same NetworkPolicy.
- Each key line in `authorized_keys` carries `restrict,port-forwarding,permitopen=...`, a second lock inside `PermitOpen`: Scott's and Olya's keys reach all four VMs, Alex's only dw-alex.
- Not covered: a flood of unauthenticated connections can fill `MaxStartups` and lock everyone out until it stops. Per-source penalties cannot help, because ServiceLB masquerades every client to one address.

## How a connection gets here

The client connects to `agents.dreamwright.app` on WAN port 2223, which OPNsense forwards to `10.1.111.20:2223`, this Service's ServiceLB address. There is no source allowlist on either hop, and the Service has no NodePort.

Port 2223 was picked because 2222 is [../jumpbox](../jumpbox) and nothing else in this repo claims it: the other LoadBalancer Services use 25, 465, 587, 993, 443 and 8080 (stalwart), 1514 (alloy-syslog), 32400 and Plex's other ports, 8091 and 3000 (zwavejs), Traefik 80 and 443, and no pod uses `hostPort` or `hostNetwork` except node-exporter on 9100. A collision would show as the `svclb-agents-jump` pod stuck Pending.

## ssh config

Each person adds this to `~/.ssh/config`, with their own key in their agent or an `IdentityFile`. Their key must also be authorized on the VM itself.

```
Host agents-jump
  HostName agents.dreamwright.app
  Port 2223
  User abc
  HostKeyAlias agents-jump
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519

Host dw-alex
  HostName 10.1.111.30
  User debian
  ProxyJump agents-jump

Host dw-robin
  HostName 10.1.111.31
  User debian
  ProxyJump agents-jump

Host dw-lindsay
  HostName 10.1.111.32
  User debian
  ProxyJump agents-jump

Host dw-eric
  HostName 10.1.111.33
  User debian
  ProxyJump agents-jump

Host dw-buster
  HostName 10.1.111.34
  User debian
  ProxyJump agents-jump
```

`IdentitiesOnly` matters because `MaxAuthTries` is 3: an agent offering more than two other keys first gets "Too many authentication failures". Point `IdentityFile` at the key that is in `authorized_keys`.

Then `ssh dw-alex`. `HostName` must be the address as written, because `PermitOpen` matches the address the client asks for. A forward refused as `administratively prohibited` is `PermitOpen`; one that hangs is the NetworkPolicy in [agents-jump-networkpolicy.yaml](agents-jump-networkpolicy.yaml). `ssh agents-jump` on its own connects and exits immediately; that is the `ForceCommand`.

The host key is generated on the pod's first start and kept on the `agents-jump-hostkeys` volume. Its fingerprint is logged on every start, so check the first `known_hosts` entry against Loki rather than trusting it on first use:

```
{namespace="agents-jump"} |= "ED25519"
```

## Manual steps for Scott

None of these are in this repo, except where noted.

1. **OPNsense port forward**: Firewall > NAT > Destination NAT, WAN TCP 2223 from any source to `10.1.111.20:2223`, with its pass rule. Set per-source limits on that pass rule, because sshd only ever sees one masqueraded address: under Advanced options, **Max new connections** `4` per `5` seconds (the field next to it), and **Max source states** `10`. If 2223 is already taken on the WAN, pick another WAN port and change `Port` in the ssh config above.
2. **DNS**: `agents.dreamwright.app` is declared in `infrastructure/prod/dns/zones/dreamwright.app.yaml` (CNAME `wan.activescott.com`, which ddclient keeps on the home WAN address). After the domain transfer on 2026-11-23 the live zone becomes the Route 53 zone in ping-poet/dreamwright-infra (`tofu/live/aws-prod/dns-mail.tf`), so the record then needs adding there.

## Changing the keys

Edit [authorized_keys](authorized_keys), one public key per line with a comment naming the person, and merge. The ConfigMap's name changes with its content, so the pod restarts onto the new list and a deleted key stops working. Adding a VM means its address in `PermitOpen` and in the NetworkPolicy egress, and a DHCP reservation.

Logs are in Loki under `{namespace="agents-jump"}`; with `LogLevel VERBOSE` each login names the key fingerprint it used.

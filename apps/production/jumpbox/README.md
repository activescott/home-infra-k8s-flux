# jumpbox

An sshd that Olya, running on the Dreamwright agents host in AWS, uses to reach what olya-0 reaches from inside the cluster: read-only `kubectl` on nas1, Grafana, Loki and Prometheus, and debeth over SSH (ping-poet/dreamwright#123). Phoenix is not routed through here, because `phoenix.activescott.com` is public.

It accepts one user, `abc`, with a key from [authorized_keys](authorized_keys) and nothing else. A session can run `kubectl` (as the `jumpbox` ServiceAccount, the same read-only access as olya-0, see [jumpbox-rbac.yaml](jumpbox-rbac.yaml)), `curl` and `jq`, and can forward only to the destinations in `PermitOpen` in [sshd_config](sshd_config).

## How a connection gets here

The agents host connects to the home WAN address on the port OPNsense forwards to `10.1.111.20:2222`, which is this Service's ServiceLB address. Two allowlists apply, both admitting only the agents host's EIP: the OPNsense rule, and `loadBalancerSourceRanges` in [jumpbox-service.yaml](jumpbox-service.yaml). A connection from the LAN is refused too, by the second one. The Service has no NodePort, because a NodePort would skip that check.

## Olya's ssh config

On the agents host, with the WAN port as forwarded in OPNsense (2222 below):

```
Host nas1-jump
  HostName wan.activescott.com
  Port 2222
  User abc
  IdentityFile ~/.ssh/nas1_jump_ed25519
  IdentitiesOnly yes
  HostKeyAlias nas1-jump
  ExitOnForwardFailure yes
  ServerAliveInterval 30

Host debeth
  HostName 10.1.111.25
  ProxyJump nas1-jump
```

`debeth`'s `User` and `IdentityFile` are the ones olya-0 uses today; that key has to be on the agents host as well. `HostName` must stay `10.1.111.25`, because `PermitOpen` matches the address the client asks for and refuses anything else.

The host key is generated on the pod's first start and kept on the `jumpbox-hostkeys` volume. Its fingerprint is logged on every start, so check the first `known_hosts` entry against Loki rather than trusting it on first use:

```
{namespace="jumpbox"} |= "ED25519"
```

## Using it

```bash
ssh nas1-jump kubectl get pods -A
ssh debeth sudo -n /usr/local/sbin/eth-logs
```

Grafana, Loki and Prometheus through local forwards, then at `http://localhost:3000`, `http://localhost:3100` and `http://localhost:9090` on the agents host:

```bash
ssh -N \
  -L 3000:grafana.monitoring.svc:80 \
  -L 3100:loki.monitoring.svc:3100 \
  -L 9090:prometheus-server.monitoring.svc:80 \
  nas1-jump
```

The target names must be written exactly as above, since that is what `PermitOpen` lists. A forward refused as `administratively prohibited` is `PermitOpen`; one that hangs is the NetworkPolicy in [jumpbox-networkpolicy.yaml](jumpbox-networkpolicy.yaml).

## Changing the key

Edit [authorized_keys](authorized_keys), one public key per line, and merge. The ConfigMap's name changes with its content, so the pod restarts onto the new list and a deleted key stops working. Until a real key is there the file holds only a comment and every login is refused.

## Why sshd runs without the image's init

The image is `lscr.io/linuxserver/openssh-server`, chosen because it ships sshd, `curl`, `jq` and `bash` on a maintained Alpine base with no image to build. Its s6 init is bypassed and sshd runs directly as `abc`. The init copies `sshd_config` onto the volume once and only ever appends to `authorized_keys`, so git would stop being what is enforced, and it sends sshd's log to a file instead of stdout. Running sshd as `abc` also means it cannot log anyone in as root. `kubectl` is copied in by an init container from `alpine/kubectl`, the pin Renovate already keeps within the API server's version skew.

Logs are in Loki under `{namespace="jumpbox"}`; with `LogLevel VERBOSE` each login names the key fingerprint it used.

# home-infra-k8s-flux

This is my Kubernetes [Flux](https://fluxcd.io/) repository. It contains everything installed in my kubernetes cluster and keeps the cluster up to date with this repo.

## Apps:

See [apps/production](apps/production).

## Image source rule: no Bitnami

**Do not add `bitnami/*` runtime images** to this repo, and don't
reach for `bitnamicharts/*` Helm charts either. There are currently
zero Bitnami workloads here — keep it that way.

**Why:** in Aug-Sep 2025 Broadcom split the Bitnami catalog (see
<https://github.com/bitnami/containers/issues/83267>). The public
`docker.io/bitnami/<image>` namespace now publishes **only
`:latest`** — no version tags, no historical digests. Concretely:

- Pinning by digest is sand. When Bitnami rebuilds `:latest`, the
  prior `amd64` sub-digest stops resolving from the public registry
  within weeks. Pods survive only on the node's local image cache;
  one node rebuild or image GC turns the pinned pod into
  `ImagePullBackOff`.
- Pinning by tag isn't a thing — only `:latest` exists. Using it
  invites silent major-version rolls. Concrete example we hit:
  `bitnami/wordpress:latest` flipped from WordPress 6.9.1 to 7.0.0
  on day-of-release; a node restart at the wrong moment would have
  rolled production from 6.x to a 7.x same-day release with zero
  GitOps diff.
- Hardened, version-pinned images are in the paid
  [Bitnami Secure Images](https://hub.docker.com/u/bitnamisecure)
  catalog. Historical Debian images live in the unpatched, frozen
  <https://hub.docker.com/u/bitnamilegacy> mirror.

**Use upstream official images instead** — `library/wordpress`,
`library/mariadb`, `library/postgres`, etc. These have stable named
version tags going back years and are maintained by the Docker
official-images team plus the upstream project. The same goes for
charts: prefer hand-written manifests (this repo's stated
preference, see below) or upstream community charts over
`bitnamicharts/*`.

**Full backstory and references:**
[`docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/summary.md`](docs/specs/wordpress-micah-mmm-bitnami-pin-upgrade/summary.md)
(the empirical evidence) and
[`docs/specs/wordpress-micah-mmm-migrate-off-bitnami/summary.md`](docs/specs/wordpress-micah-mmm-migrate-off-bitnami/summary.md)
(how the last Bitnami workload was migrated off and what was learned
along the way).

## Usage

### New hostname checklist

To give an app a new public URL like `myapp.activescott.com`:

1. **Public DNS (Cloudflare):** add `myapp.activescott.com` as a CNAME to
   `k8s.activescott.com` (which resolves to the cluster's public IP). Match the
   proxy on/off setting of an existing app record (e.g. `phoenix.activescott.com`).
2. **Local DNS (optional but recommended for high-bandwidth apps):** the LAN's DNS
   server carries A-record overrides pointing some hostnames (e.g.
   `grafana.activescott.com`) at the cluster's LAN IP `10.1.111.20`, so LAN clients
   skip the NAT-hairpin through the router. Hairpin does work — apps without an
   override are still reachable from the LAN via the public IP — so this is a
   performance nicety, not a requirement. Add the override on the local DNS server
   (10.1.111.1).
3. **Certificate + Ingress:** add a cert-manager `Certificate` (issuer
   `letsencrypt-production`, HTTP-01) and an `Ingress` with matching
   `tls.secretName` — copy `apps/production/arize-phoenix/app-ingress*.yaml`.
   Issuance needs step 1 live first.

Gotcha: if a hostname was queried before its record existed, resolvers hold a
negative cache for several minutes — an empty `dig` answer right after adding the
record usually just means wait, not that the record is wrong. Check what's actually
published with `dig +short myapp.activescott.com @1.1.1.1`.

### Handy CLI Commands working with Flux

See [Flux Troubleshooting Cheatsheet](https://fluxcd.io/flux/cheatsheets/troubleshooting/).

```sh
# usually most informative:
flux get kustomizations --watch

# very informative too, but very detailed:
flux logs -f

# force reconciliation to source:
flux reconcile kustomization flux-system --with-source

# force reconciliation of (docker) image repository:
flux -n scott-willeke-com-prod reconcile image repository repo-scott-willeke-com
flux -n ramblefeed-prod reconcile image repository repo-ramblefeed-app

# Show all Flux objects that are not ready !
flux get all -A --status-selector ready=false

# watch flux events:
flux events -w

# Show flux warning events
kubectl get events -n flux-system --field-selector type=Warning

flux get kustomizations --watch

###############
#
# To fix something manually while flux won't constantly replace them do this:
flux suspend kustomization apps
# then make changes
# then resume:
flux resume kustomization apps
#
###############

flux reconcile kustomization apps

# I find it helpful to get logs directly from the kustomization controller:
kubectl -n flux-system logs -f deployment/kustomize-controller


# Automated Image Updates:
# check the image repository (per https://fluxcd.io/flux/guides/image-update/)
flux get image repository -n tayle-prod repo-tayle-app

# list images flux is tracking:
flux get images all --all-namespaces

# list the image policies:
flux get images -A policy

# list all image repositories:
kubectl get -A imagerepository

# list the tags found in an image repository:
kubectl get -n tayle-prod -o=yaml imagerepository/repo-tayle-worker

# reconcile an image repository:
flux -n gpupoet-prod reconcile image repository repo-gpupoet-app
flux -n tinkerbell-prod reconcile image repository repo-tinkerbell-app
flux -n tayle-prod reconcile image repository repo-tayle-app
flux -n tayle-prod reconcile image repository repo-tayle-worker

# a handy way to do a dry run on the kustomize (this prints a lot of warnings when it works but returns non-zero as long as there are no errors):
kubectl kustomize apps/production | kubectl apply --dry-run='server' -f -
```

### Cluster Layout

```
├── apps
│   ├── base
│   ├── production
│   └── staging
├── infrastructure
│   ├── base
│   ├── production
│   └── staging
└── clusters
    ├── production
    └── staging
```

per https://fluxcd.io/flux/guides/repository-structure/
example at https://github.com/fluxcd/flux2-kustomize-helm-example

### Secrets

Using [sops](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age).

#### Encrypting

TLDR: put .env files in a dirctory and then run `/scripts/encrypt-env-files.sh <dir>` on the dir containing the .env file and it will save `.env*.encrypted` files that you can reference in kustomization files like:

```yaml
secretGenerator:
  # db
  - name: db-creds
    envs:
      - .env.secret.db.encrypted
```

Per https://fluxcd.io/flux/guides/mozilla-sops/#encrypting-secrets-using-age

#### Decrypting

The flux+kustomize knows how to decrypt SOPS secrets via secret generator. So we just have to have a `sops-age` secret in the `flux-system` namespace in the cluster.

See `/infrastructure/configs/create-sops-age-decryption-secret.sh`

Per https://fluxcd.io/flux/guides/mozilla-sops/#encrypting-secrets-using-age

### Image Pull Secrets

Image Pull Secrets (to [Pull an Image from a Private Registry](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)) using `.dockerconfigjson` secrets are kinda just like json secrets. Run:

```sh
./scripts/create-image-pull-secret-ghcr.sh
```

Per https://fluxcd.io/flux/components/kustomize/kustomizations/#kustomize-secretgenerator

### Image Updates & Image Scanning

Image scanning for one app setup at `apps/production/tayle/image-scanning` per https://fluxcd.io/flux/guides/image-update/

#### OCI Labels Required for GHCR Webhook Events

Each app's Docker build workflow must include OCI labels (`org.opencontainers.image.source` and `org.opencontainers.image.revision`) on the container image. These labels link the GHCR package to its GitHub repo, which is required for GitHub to send package webhook events. Without them, Flux image automation won't receive notifications when new images are published. See the `labels:` parameter in each app's `docker/build-push-action` step.

#### Image Updates from Github Web Hooks for Continuous Deployment

A flux webhook receiver is set up in `/infrastructure/base/configs/image-scanning-webhook-receiver`. It has configured which ImageRepositories to refresh. More can be added.

Add a webhook to github like:

Get the ReceiverURL by running `kubectl -n flux-system get receiver` it will print it out as its status.

> On GitHub, navigate to your repository and click on the “Add webhook” button under “Settings/Webhooks”. Fill the form with:
> Payload URL: compose the address using the receiver LB and the generated URL http://<LoadBalancerAddress>/<ReceiverURL>
> Secret: use the token string
>
> With the above settings, when you push a commit to the repository, the following happens:
>
> GitHub sends the Git push event to the receiver address
> Notification controller validates the authenticity of the payload using HMAC
> Source controller is notified about the changes
> Source controller pulls the changes into the cluster and updates the GitRepository revision
> Kustomize controller is notified about the revision change
> Kustomize controller reconciles all the Kustomizations that reference the GitRepository object

per https://fluxcd.io/flux/guides/webhook-receivers/

### Restoring a Cluster from Flux Repo

You can use the flux bootstrap at anytime to re-provision the cluster with everything in flux. I've done this on a clean k3s a few times now and it works flawlessly:


```sh
  flux bootstrap github \
  --token-auth \
  --owner=activescott \
  --repository=home-infra-k8s-flux \
  --branch=main \
  --path=clusters/nas1 \
  --personal \
  --components-extra=image-reflector-controller,image-automation-controller                                                                                                                                                                                                                                                                                                                  
```

Since I use SOPS to encrypt secrets and keep them in git, need to provision that root key
```sh
./scripts/create-sops-age-decryption-secret.sh
```

Force reconcile:

```sh
flux reconcile kustomization infra-configs
```

...that should should show some output "waiting for Kustomization reconciliation..."


Then you can monitor with:

```sh
flux logs -f

# or flux get kustomization --watch
```

Should see output lines like `Namespace/activescott-redirect created` for each flux resource as it is created. 


### YAML+Kustomize

I prefer plain "kubectl yaml" and Kustomize over helm for resources authored in this repo — Helm is for packaging an app into an opaque package to provide to others, not for managing a cluster directly. Consuming upstream Helm charts is a different matter: it's perfectly fine (via Flux `HelmRelease`) when the chart is well maintained and clearly documented, and often better than hand-porting a complex app, since the chart encodes the app's env/volume/probe contracts that hand-rolled manifests have to rediscover. Prefer upstream kustomize/yaml when the app provides it; reach for the chart when it doesn't or when the app has many moving parts.

## Posterity / Done

- [x] Bootstrap
      See script for this in scripts dir. it was updated.

```
flux bootstrap github \
--token-auth \
--owner=activescott \
--repository=home-infra-k8s-flux \
--branch=main \
--path=clusters/nas1 \
--personal
```

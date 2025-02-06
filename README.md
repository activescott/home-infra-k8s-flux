# home-infra-k8s-flux

This is my kubernetes flux repository. It contains everything installed in my kubernetes cluster and keeps the cluster up to date with this repo.

NOTE: IN PROGRESS. Still converting my old repo containing kubernetes resources – https://github.com/activescott/home-infra – to this one.

## Usage

###

Quick handy CLI Commands

```sh
flux get kustomizations --watch

flux resume kustomization apps

flux reconcile kustomization apps
```

### Cluster Layout

```
├── apps
│   ├── base
│   ├── production
│   └── staging
├── infrastructure
│   ├── base
        ├── configs
        ├── controllers
│   ├── production
        ├── configs
        ├── controllers
│   └── staging
└── clusters
    ├── production
    └── staging
```

per https://fluxcd.io/flux/guides/repository-structure/
example at https://github.com/fluxcd/flux2-kustomize-helm-example

#### Key Points:

**Apps:**

- Put the common parts of new apps in `apps/base/<app-name>`
- Put the environment-specific (e.g. production vs staging) overlays in `apps/<environment>/<app-name>`. Overlays reference the base with a kustomization.yaml file and add any overlay-specific things like maybe changing namespaces or storage resources, ingress domains/certs or other tenant-specific resources.
- Then in each cluster such as `clusters/nas1`, reference the apps environment(s) you want to deploy with a flux Kustomization resource (Flux has it's own Kustomization resource to build & deploy kustomize-yaml).

**Infra:**

- `infrastructure/base/config` contains customized infrastructure configuration resources
- infrastructure/<environment>/config will reference the base and use it as-is or make any environment-specific changes.

### Secrets

Using [sops](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age).

#### Encrypting

```sh
SOPS_AGE_KEY_FILE=/Users/scott/src/activescott/home-infra/k8s/home-infra-private.agekey sops encrypt --age age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt --input-type dotenv --output-type dotenv .env.secret.transmission > .env.enc.transmission
```

Use a file like `.env.enc.<app-name>`
Per https://fluxcd.io/flux/guides/mozilla-sops/#encrypting-secrets-using-age

#### Decrypting

The flux+kustomize knows how to decrypt SOPS secrets via secret generator. So we just have to have a `sops-age` secret in the `flux-system` namespace in the cluster.

See `/infrastructure/configs/create-sops-age-decryption-secret.sh`

Per https://fluxcd.io/flux/guides/mozilla-sops/#encrypting-secrets-using-age

#### Image Pull Secrets

Image Pull Secrets (to [Pull an Image from a Private Registry](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)) using `.dockerconfigjson` secrets are kinda just like json secrets. Run:

```sh
./scripts/create-image-pull-secret-ghcr.sh
```

Per https://fluxcd.io/flux/components/kustomize/kustomizations/#kustomize-secretgenerator

### YAML+Kustomize

I prefer plain "kubectl yaml" and Kustomize over helm. Helm is great for packaging up an app into an opaque package and provide it to others, but IMHO not for managing a cluster directly. When consuming apps, I prefer consuming yaml if provided, but don't mind consuming Helm.

## TODO:

- [x] Setup transmission app with secrets
- [x] Setup tayle app with secrets
- [ ] Setup image updates for tayle and transmission: https://fluxcd.io/flux/guides/image-update/
- [ ] Expose webhook receiver for tayle main: https://fluxcd.io/flux/guides/webhook-receivers/ ?

## Posterity / Done

- [x] Bootstrap

```
flux bootstrap github \
  --token-auth \
  --owner=activescott \
  --repository=home-infra-k8s-flux \
  --branch=main \
  --path=clusters/nas1 \
  --personal
```

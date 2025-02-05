# home-infra-k8s-flux

This is my kubernetes flux repository. It contains everything installed in my kubernetes cluster and keeps the cluster up to date with this repo.

NOTE: IN PROGRESS. Still converting my old repo containing kubernetes resources – https://github.com/activescott/home-infra – to this one.

## Usage

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

```sh
SOPS_AGE_KEY_FILE=/Users/scott/src/activescott/home-infra/k8s/home-infra-private.agekey sops encrypt --age age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt --input-type dotenv --output-type dotenv .env.secret.transmission > .env.enc.transmission
```

Use a file like `.env.enc.<app-name>`
Per https://fluxcd.io/flux/guides/mozilla-sops/#encrypting-secrets-using-age

#### Decrypting

The flux+kustomize knows how to decrypt SOPS secrets via secret generator. So we just have to have a `sops-age` secret in the cluster and in teh `flux-system` namespace.

See `/infrastructure/configs/create-sops-age-decryption-secret.sh`

set the decryption secret in the Flux Kustomization to sops-age.

Per https://fluxcd.io/flux/guides/mozilla-sops/#encrypting-secrets-using-age

### YAML+Kustomize

I prefer plain "kubectl yaml" and Kustomize over helm. Helm is great for packaging up an app into an opaque package and provide it to others, but IMHO not for managing a cluster directly. When consuming apps, I prefer consuming yaml if provided, but don't mind consuming Helm.

## TODO:

- [ ] Setup transmission with secrets
- [ ] Setup image updates: https://fluxcd.io/flux/guides/image-update/
- [ ] Setup transmission with image updates and
- [ ] Expose webhook receiver for tayle main: https://fluxcd.io/flux/guides/webhook-receivers/

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

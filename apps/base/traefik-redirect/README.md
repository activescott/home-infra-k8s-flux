# Traefik Redirect Base Template

Reusable base for creating domain redirects using Traefik middleware.

## How it works

- Uses Traefik Ingress Controller's middleware (redirectRegex) in the Ingress
- **Important**: Traefik middleware requires a discoverable service/pod to function,
  even though traffic never reaches it (middleware redirects before backend is contacted)
- This base provides a minimal "sleeper" pod running `sleep infinity`
- Headless services and externalIP services don't work - Traefik needs a real endpoint

## External Requirements

For each redirect domain, you need:
1. DNS A record pointing to the cluster's external IP
2. Port forward for HTTPS/443 to the cluster (if behind NAT)

## Usage

Create a production overlay with a `kustomization.yaml` that:
1. References this base
2. Sets `namespace` and `namePrefix`
3. Defines a `configMapGenerator` with redirect variables
4. Provides a `namespace.yaml`

### Example kustomization.yaml

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/traefik-redirect/
  - ./namespace.yaml

namespace: example-redirect
namePrefix: example-

configMapGenerator:
  - name: redirect-vars
    literals:
      - HOST=example.com
      - REGEX=^https?://example\.com/.*
      - REPLACEMENT=https://destination.com/
      - MIDDLEWARE_REF=example-redirect-example-redirect-middleware@kubernetescrd
      - TLS_SECRET=example-com-tls

# Replacements inject ConfigMap values into Middleware and Ingress
replacements:
  - source:
      kind: ConfigMap
      name: redirect-vars
      fieldPath: data.HOST
    targets:
      - select:
          kind: Ingress
          name: redirect-ingress
        fieldPaths:
          - spec.rules.0.host
          - spec.tls.0.hosts.0
  - source:
      kind: ConfigMap
      name: redirect-vars
      fieldPath: data.REGEX
    targets:
      - select:
          kind: Middleware
          name: redirect-middleware
        fieldPaths:
          - spec.redirectRegex.regex
  - source:
      kind: ConfigMap
      name: redirect-vars
      fieldPath: data.REPLACEMENT
    targets:
      - select:
          kind: Middleware
          name: redirect-middleware
        fieldPaths:
          - spec.redirectRegex.replacement
  - source:
      kind: ConfigMap
      name: redirect-vars
      fieldPath: data.MIDDLEWARE_REF
    targets:
      - select:
          kind: Ingress
          name: redirect-ingress
        fieldPaths:
          - metadata.annotations.[traefik.ingress.kubernetes.io/router.middlewares]
  - source:
      kind: ConfigMap
      name: redirect-vars
      fieldPath: data.TLS_SECRET
    targets:
      - select:
          kind: Ingress
          name: redirect-ingress
        fieldPaths:
          - spec.tls.0.secretName

buildMetadata: [originAnnotations, transformerAnnotations]

commonLabels:
  app.activescott.com/name: example-redirect
```

### Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `HOST` | Source domain to redirect from | `example.com` |
| `REGEX` | Regex to match incoming URLs | `^https?://example\.com/.*` |
| `REPLACEMENT` | Target URL to redirect to | `https://destination.com/` |
| `MIDDLEWARE_REF` | Traefik middleware reference | `<namespace>-<namePrefix>redirect-middleware@kubernetescrd` |
| `TLS_SECRET` | Name for the TLS certificate secret | `example-com-tls` |

### MIDDLEWARE_REF Format

The middleware reference follows the pattern:
```
<namespace>-<namePrefix>redirect-middleware@kubernetescrd
```

For example, with `namespace: foo-redirect` and `namePrefix: foo-`:
```
foo-redirect-foo-redirect-middleware@kubernetescrd
```

## Resource Usage

- CPU: 0.1m request, 0.2 limit
- Memory: 2Mi request, 128Mi limit

## Examples

See:
- `apps/production/activescott-redirect/` - redirects activescott.com → scott.willeke.com
- `apps/production/oksana-willeke-redirect/` - redirects www.oksana.willeke.com → oxanawillekecoaching.com

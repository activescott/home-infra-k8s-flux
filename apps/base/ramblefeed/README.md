# Ramblefeed Base Kubernetes Resources

These resources are copied from the ramblefeed repository at `/k8s/base/` and adapted for production use.

**Source**: https://github.com/activescott/ramblefeed/tree/main/k8s/base

## Differences from Source

- Secrets are referenced via `secretKeyRef` instead of hardcoded values
- Image references use placeholder names for kustomize image transformers
- Resources are adjusted for production use

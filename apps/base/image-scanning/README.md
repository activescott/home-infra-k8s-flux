# Image Scanning Base

Image scanning is centralized in `infrastructure/prod/configs/image-scanning/`.
All ImageRepository and ImagePolicy resources live in the `flux-system` namespace,
co-located with the `update-images` ImageUpdateAutomation.

The base templates in `timestamp/` and `semver/` are retained for reference but
are no longer used by per-app kustomizations.

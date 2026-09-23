#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
this_script=$(basename $0)

# THIS SCRIPT PER https://fluxcd.io/flux/installation/bootstrap/github/#github-pat

# get the GITHUB_TOKEN from the environment, else decrypt it from git (nothing written to disk):
token_secret="scripts/.env.secret.flux-bootstrap"
if [ -z "$GITHUB_TOKEN" ]; then
  GITHUB_TOKEN=$("$this_dir/onepassword-secrets.mts" show "$token_secret" \
    | sed -E -n "s/^GITHUB_TOKEN=[\"']?([^\"']*)[\"']?[[:space:]]*\$/\1/p" | head -n 1)
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN is not set in the environment and no GITHUB_TOKEN= line came from"
  echo "  ./scripts/onepassword-secrets.mts show $token_secret (see its errors above)"
  exit 1
fi


# --components-extra added per https://fluxcd.io/flux/guides/image-update/#install-flux
# and https://fluxcd.io/flux/installation/configuration/optional-components/

GITHUB_TOKEN=$GITHUB_TOKEN \
  flux bootstrap github \
  --components-extra=image-reflector-controller,image-automation-controller \
  --token-auth \
  --owner=activescott \
  --repository=home-infra-k8s-flux \
  --branch=main \
  --path=clusters/nas1 \
  --personal
  

#!/usr/bin/env bash
set -euo pipefail

this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
repo_dir=$(cd "$this_dir/.."; pwd) # parent directory

KEY_FILE="$repo_dir/home-infra-private.agekey"

# Verify the key file exists and is not empty
if [[ ! -f "$KEY_FILE" ]]; then
  echo "ERROR: Private key file not found at: $KEY_FILE" >&2
  exit 1
fi

if [[ ! -s "$KEY_FILE" ]]; then
  echo "ERROR: Private key file is empty: $KEY_FILE" >&2
  exit 1
fi

# NOTE: This is the private key. DO NOT SHARE THE CONTENTS OF WHAT THIS GENERATES.

# NOTE: Create a secret with the age PRIVATE KEY, the key name must end with .agekey to be detected as an age key:
cat "$KEY_FILE" |
kubectl create secret generic sops-age \
--namespace=flux-system \
--from-file="home-infra-private.agekey=/dev/stdin"

# Verify the secret was created with non-empty data
echo "Verifying secret was created correctly..."
SECRET_SIZE=$(kubectl get secret sops-age -n flux-system -o jsonpath='{.data.home-infra-private\.agekey}' | base64 -d | wc -c | tr -d ' ')

if [[ "$SECRET_SIZE" -eq 0 ]]; then
  echo "ERROR: Secret was created but contains no data!" >&2
  exit 1
fi

echo "SUCCESS: Secret 'sops-age' created with $SECRET_SIZE bytes of key data"

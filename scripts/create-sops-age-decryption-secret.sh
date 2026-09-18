#!/usr/bin/env bash
# Creates or replaces the flux-system/sops-age secret from the age private key(s) in
# 1Password. This is the one thing in this repo that cannot be GitOps'd: it is what
# decrypts git, so it cannot live in git.
#
# kustomize-controller imports every data entry whose key ends in .agekey and tries each
# identity, so during a rotation both keys go in and the cluster can read ciphertext
# encrypted to either. That is what removes the outage window between merging re-encrypted
# files and swapping the key. See docs/specs/age-key-only-secrets/plan.md.
#
# Usage:
#   ./scripts/create-sops-age-decryption-secret.sh [attachment name]...
#
# With no arguments, every *.agekey attachment on the 1Password item is used, except
# retired ones (names containing "-retired-"). Name them explicitly to narrow it, e.g.
# after a rotation:
#   ./scripts/create-sops-age-decryption-secret.sh home-infra-private-20260918.agekey
#
# Either way it refuses to apply unless one of the keys has the public key declared in
# scripts/_sops_config.include.sh, so narrowing to the wrong key cannot stall Flux.
#
# Written for bash 3.2 too (macOS /bin/bash): no mapfile, no here-docs.
set -euo pipefail

ITEM_TITLE="home-infra kubernetes secrets sops-age-key"
VAULT="${OP_VAULT:-Private}"
CONTEXT="${KUBE_CONTEXT:-nas}"

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
source "$repo_dir/scripts/_sops_config.include.sh"

for tool in op kubectl jq age-keygen; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool not found on PATH" >&2; exit 1; }
done

item_json=$(op item get "$ITEM_TITLE" --vault "$VAULT" --format json)
item_id=$(echo "$item_json" | jq -r '.id')

attachments=()
if [[ $# -gt 0 ]]; then
  attachments=("$@")
else
  while IFS= read -r name; do
    attachments+=("$name")
  done < <(echo "$item_json" |
    jq -r '.files[]?.name | select(endswith(".agekey") and (contains("-retired-") | not))')
fi

if [[ ${#attachments[@]} -eq 0 ]]; then
  echo "ERROR: no *.agekey attachment on \"$ITEM_TITLE\" in vault $VAULT" >&2
  exit 1
fi

echo "Building sops-age from ${#attachments[@]} key(s): ${attachments[*]}"

# The key never lands on disk and never appears in an argv. It is held in shell variables
# and only ever written by printf, a builtin, into pipes. A here-doc is avoided on purpose:
# bash before 5.1 backs here-docs with a temp file.
data_entries=""
found_recipient=0
for name in "${attachments[@]}"; do
  key=$(op read "op://$VAULT/$item_id/$name")
  if [[ -z "$key" ]]; then
    echo "ERROR: attachment \"$name\" is empty" >&2
    exit 1
  fi
  public=$(printf '%s\n' "$key" | age-keygen -y)
  if [[ $'\n'"$public"$'\n' == *$'\n'"$age_key_public"$'\n'* ]]; then
    found_recipient=1
  fi
  encoded=$(printf '%s\n' "$key" | base64 | tr -d '\n')
  data_entries+="  ${name}: ${encoded}"$'\n'
done
key=""

if [[ $found_recipient -ne 1 ]]; then
  echo "ERROR: none of ${attachments[*]} has the public key $age_key_public" >&2
  echo "       (age_key_public in scripts/_sops_config.include.sh). Nothing was applied." >&2
  exit 1
fi

manifest="apiVersion: v1
kind: Secret
metadata:
  name: sops-age
  namespace: flux-system
type: Opaque
data:
${data_entries}"
printf '%s' "$manifest" | kubectl --context "$CONTEXT" apply -f -

echo "Verifying..."
for name in "${attachments[@]}"; do
  escaped=${name//./\\.}
  size=$(kubectl --context "$CONTEXT" get secret sops-age -n flux-system \
    -o "jsonpath={.data.${escaped}}" | base64 -d | wc -c | tr -d ' ')
  if [[ "$size" -eq 0 ]]; then
    echo "ERROR: $name is present but empty in the secret" >&2
    exit 1
  fi
  echo "  $name: $size bytes"
done

echo "SUCCESS: secret 'sops-age' holds ${#attachments[@]} age identity/identities"

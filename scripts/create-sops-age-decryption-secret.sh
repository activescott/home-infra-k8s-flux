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
# With no arguments, every *.agekey attachment on the 1Password item is used. Name them
# explicitly to narrow it, e.g. after a rotation:
#   ./scripts/create-sops-age-decryption-secret.sh home-infra-private-20260918.agekey
set -euo pipefail

ITEM_TITLE="home-infra kubernetes secrets sops-age-key"
VAULT="${OP_VAULT:-Private}"
CONTEXT="${KUBE_CONTEXT:-nas}"

for tool in op kubectl jq; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool not found on PATH" >&2; exit 1; }
done

item_json=$(op item get "$ITEM_TITLE" --vault "$VAULT" --format json)
item_id=$(echo "$item_json" | jq -r '.id')

if [[ $# -gt 0 ]]; then
  attachments=("$@")
else
  mapfile -t attachments < <(echo "$item_json" | jq -r '.files[]?.name | select(endswith(".agekey"))')
fi

if [[ ${#attachments[@]} -eq 0 ]]; then
  echo "ERROR: no *.agekey attachment on \"$ITEM_TITLE\" in vault $VAULT" >&2
  exit 1
fi

echo "Building sops-age from ${#attachments[@]} key(s): ${attachments[*]}"

# The key never lands on disk and never appears in an argv. `op read` writes it to this
# pipeline's stdin only; base64 output is the only form that reaches the manifest.
data_entries=""
for name in "${attachments[@]}"; do
  encoded=$(op read "op://$VAULT/$item_id/$name" | base64 | tr -d '\n')
  if [[ -z "$encoded" ]]; then
    echo "ERROR: attachment \"$name\" is empty" >&2
    exit 1
  fi
  data_entries+="  ${name}: ${encoded}"$'\n'
done

kubectl --context "$CONTEXT" apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: sops-age
  namespace: flux-system
type: Opaque
data:
${data_entries}
EOF

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

#!/usr/bin/env bash
# Build the SOPS-encrypted Cloudflare credential that Crossplane's ProviderConfig consumes.
#
# The Cloudflare Terraform provider (which provider-upjet-cloudflare is generated from)
# expects a JSON blob with an "api_token" key, not a dotenv variable. Scott pastes the raw
# token into .env.secret.cloudflare (gitignored, never read by an agent); this script reshapes
# it into JSON and encrypts it, without ever printing the value.
#
# Mirrors scripts/create-zot-sync-credentials.sh -- same sops invocation, same
# "generator key selects the SOPS format" constraint (see the comment in the
# crossplane-config kustomization).
#
# Usage: ./scripts/create-cloudflare-credentials.sh

this_dir=$(cd "$(dirname "$0")"; pwd)
repo_dir=$(cd "$this_dir/.."; pwd)

set -euo pipefail

config_dir="$repo_dir/infrastructure/prod/controllers/crossplane-config"
env_file="$config_dir/.env.secret.cloudflare"
plain_json="$config_dir/cloudflare-credentials.json"
encrypted="$config_dir/cloudflare-credentials.json.encrypted"

if [ ! -f "$env_file" ]; then
  echo "Error: $env_file not found." >&2
  echo "Create it with a single line: CLOUDFLARE_API_TOKEN=<token>" >&2
  exit 1
fi

# shellcheck disable=SC1090  # runtime path, not resolvable at lint time
source "$env_file"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ "$CLOUDFLARE_API_TOKEN" = "REPLACE_ME" ]; then
  echo "Error: CLOUDFLARE_API_TOKEN is unset or still the placeholder in $env_file" >&2
  exit 1
fi

# jq --arg keeps the value out of the process list and handles escaping.
jq -n --arg t "$CLOUDFLARE_API_TOKEN" '{api_token: $t}' > "$plain_json"

source "$this_dir/_sops_config.include.sh"

sops encrypt \
  --age "$age_key_public" \
  --input-type=json \
  --output-type=json "$plain_json" > "$encrypted"

rm -f "$plain_json"

cat <<EOF
Encrypted Cloudflare credential written to:
  ${encrypted}

Sanity-check the round trip before committing (prints key names only, not the token):
  SOPS_AGE_KEY_FILE=$repo_dir/home-infra-private.agekey \\
    sops -d --input-type json --output-type json ${encrypted} | jq 'keys'
  # expect: ["api_token"]

The plaintext .env.secret.cloudflare and cloudflare-credentials.json are gitignored.
Keep the token in 1Password as the backup of record.
EOF

#!/usr/bin/env bash
# Build the SOPS-encrypted Cloudflare credentials that Crossplane's ProviderConfigs consume.
#
# The Cloudflare Terraform provider (which provider-upjet-cloudflare is generated from)
# expects a JSON blob with an "api_token" key, not a dotenv variable. Scott pastes the raw
# tokens into the .env.secret.* files (gitignored, never read by an agent); this script
# reshapes each into JSON and encrypts it, without ever printing the value.
#
# There are TWO tokens, because Cloudflare rate-limits per token: 1,200 requests per 5 minutes,
# and exceeding it 429s every call for the next 5 minutes. An upjet Observe costs ~9 API calls
# per managed resource and a fresh provider pod observes everything at once, so one token
# across all resources put a cold sweep at ~1,186 calls -- 99% of the budget in one burst, with
# Email Routing at the tail absorbing the rejections. Splitting the token splits the budget.
# See the header of .env.secret.cloudflare-email for the full measurement.
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

# One row per token: <env file suffix>:<variable name>:<output basename>
credentials=(
  "cloudflare:CLOUDFLARE_API_TOKEN:cloudflare-credentials"
  "cloudflare-email:CLOUDFLARE_EMAIL_API_TOKEN:cloudflare-email-credentials"
)

source "$this_dir/_sops_config.include.sh"

for row in "${credentials[@]}"; do
  IFS=':' read -r suffix var_name basename <<< "$row"

  env_file="$config_dir/.env.secret.$suffix"
  plain_json="$config_dir/$basename.json"
  encrypted="$config_dir/$basename.json.encrypted"

  if [ ! -f "$env_file" ]; then
    echo "Error: $env_file not found." >&2
    echo "Create it with a single line: $var_name=<token>" >&2
    exit 1
  fi

  # Read the value in a subshell so one token never leaks into the next iteration's
  # environment, and so a typo'd variable name fails loudly instead of silently reusing
  # whatever the previous `source` left behind.
  # shellcheck disable=SC1090  # runtime path, not resolvable at lint time
  token=$(source "$env_file"; printf '%s' "${!var_name:-}")

  if [ -z "$token" ] || [ "$token" = "REPLACE_ME" ]; then
    echo "Error: $var_name is unset or still the placeholder in $env_file" >&2
    exit 1
  fi

  # jq --arg keeps the value out of the process list and handles escaping.
  jq -n --arg t "$token" '{api_token: $t}' > "$plain_json"
  unset token

  sops encrypt \
    --age "$age_key_public" \
    --input-type=json \
    --output-type=json "$plain_json" > "$encrypted"

  rm -f "$plain_json"

  echo "Encrypted: $encrypted"
done

cat <<EOF

Sanity-check the round trips before committing (prints key names only, not the tokens):
  for f in $config_dir/cloudflare-credentials.json.encrypted \\
           $config_dir/cloudflare-email-credentials.json.encrypted; do
    SOPS_AGE_KEY_FILE=$repo_dir/home-infra-private.agekey \\
      sops -d --input-type json --output-type json "\$f" | jq 'keys'
  done
  # expect: ["api_token"] twice

The plaintext .env.secret.* and *-credentials.json files are gitignored.
Keep both tokens in 1Password as the backup of record.
EOF

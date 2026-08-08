#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
parent_dir=$(cd $(dirname "$this_dir"); pwd) # parent directory
repo_dir=$(cd "$parent_dir"; pwd) # repository directory

#-e: Exits immediately if any command returns a non-zero status (i.e., fails)
#-u: Treats unset variables as errors and exits immediately
#-o pipefail: If any command in a pipeline fails, the entire pipeline fails
set -eo pipefail

# Prompt for credentials
read -p "Docker Hub username: " dockerhub_username
if [ -z "$dockerhub_username" ]; then
  echo "Error: username is required."
  exit 1
fi

echo ""
echo "Enter a Docker Hub access token with 'Public Repo Read-only' scope."
echo "Create one at: https://app.docker.com/settings/personal-access-tokens/create"
echo ""
read -s -p "Docker Hub access token: " dockerhub_token
echo ""
if [ -z "$dockerhub_token" ]; then
  echo "Error: token is required."
  exit 1
fi

# Never write plaintext credentials into the repo tree - use a temp dir that
# is guaranteed to be cleaned up even on failure.
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# zot's sync extension looks up credentials by the exact host from the
# registry's "urls" entry in config.json (currently "https://index.docker.io"),
# so the key here MUST be "index.docker.io" verbatim - not "docker.io", not
# "registry-1.docker.io". Getting this wrong fails SILENTLY: zot falls back
# to anonymous and you only find out later via Docker Hub rate-limit errors.
credentials_file="$tmpdir/credentials.json"
cat <<EOF > "${credentials_file}"
{
  "index.docker.io": {
    "username": "${dockerhub_username}",
    "password": "${dockerhub_token}"
  }
}
EOF

# Now encrypt it per https://fluxcd.io/flux/components/kustomize/kustomizations/#kustomize-secretgenerator
credentials_file_encrypted="$repo_dir/apps/production/zot/zot-sync-credentials.json.encrypted"

# Prepare for sops:
source "$this_dir/_sops_config.include.sh"

sops -encrypt \
  --age "$age_key_public" \
  --input-type=json \
  --output-type=json "$credentials_file" > "$credentials_file_encrypted"

cat <<EOF
The encrypted Docker Hub sync credential has been saved to:
  ${credentials_file_encrypted}

Sanity-check the round-trip before committing:
  SOPS_AGE_KEY_FILE=$repo_dir/home-infra-private.agekey \\
    sops -d --input-type json --output-type json ${credentials_file_encrypted} | jq 'keys'
  # expect: ["index.docker.io"]

To deploy, commit and push:

  git add apps/production/zot/zot-sync-credentials.json.encrypted
  git commit -m "rotate zot Docker Hub sync credential"
  git push
EOF

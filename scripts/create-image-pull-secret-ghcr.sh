#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
parent_dir=$(cd $(dirname "$this_dir"); pwd) # parent directory
repo_dir=$(cd "$parent_dir"; pwd) # repository directory

#-e: Exits immediately if any command returns a non-zero status (i.e., fails)
#-u: Treats unset variables as errors and exits immediately
#-o pipefail: If any command in a pipeline fails, the entire pipeline fails
set -eo pipefail

# Prompt for credentials
read -p "GitHub username: " github_username
if [ -z "$github_username" ]; then
  echo "Error: username is required."
  exit 1
fi

echo ""
echo "Enter a GitHub Personal Access Token (classic) with the read:packages scope."
echo "Create one at: https://github.com/settings/tokens/new?scopes=read:packages"
echo ""
read -s -p "GitHub PAT: " github_token
echo ""
if [ -z "$github_token" ]; then
  echo "Error: token is required."
  exit 1
fi

read -p "GitHub email: " github_email
if [ -z "$github_email" ]; then
  echo "Error: email is required."
  exit 1
fi

# Calculate the base64-encoded auth string (username:token)
auth=$(echo -n "$github_username:$github_token" | base64)

# Create a temporary docker config JSON file with the registry credentials
config_file="$this_dir/ghcr.dockeronfigjson"
cat <<EOF > "${config_file}"
{
  "auths": {
    "ghcr.io": {
      "username": "${github_username}",
      "password": "${github_token}",
      "email": "${github_email}",
      "auth": "${auth}"
    }
  }
}
EOF

# Now encrypt it per https://fluxcd.io/flux/components/kustomize/kustomizations/#kustomize-secretgenerator
config_file_encrypted="$repo_dir/apps/production/shared/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted"

# Prepare for sops:
source "$this_dir/_sops_config.include.sh"

sops -encrypt \
  --age "$age_key_public" \
  --input-type=json \
  --output-type=json "$config_file" > "$config_file_encrypted"

cat <<EOF
The encrypted docker config JSON file has been saved to:
  ${config_file_encrypted}

All apps reference this shared file via their kustomization.yaml resources.
To deploy the updated secret, just commit and push:

  git add apps/production/shared/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted
  git commit -m "rotate GHCR pull secret"
  git push
EOF

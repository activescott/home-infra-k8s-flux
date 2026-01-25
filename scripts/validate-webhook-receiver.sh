#!/usr/bin/env bash
set -euo pipefail

# Validates that all ImageRepository resources are registered in the webhook Receiver
# This script uses kubectl kustomize to work with the base/overlay structure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ANSI color codes
YELLOW='\033[1;33m'
RED='\033[0;31m'
GREEN='\033[0;32m'
RESET='\033[0m'

kubectl_context=nas

# Extract all ImageRepository resources from kustomized apps
get_image_repositories_from_apps() {
  kubectl --context "$kubectl_context" kustomize "$REPO_ROOT/apps/production" 2>/dev/null | \
    yq -r 'select(.kind == "ImageRepository") | .metadata.namespace + "/" + .metadata.name' | \
    grep -v '^---$' | sort | uniq
}

# Extract ImageRepository references from the webhook Receiver
get_image_repositories_from_receiver() {
  kubectl --context "$kubectl_context" kustomize "$REPO_ROOT/infrastructure/prod/configs" 2>/dev/null | \
    yq -r 'select(.kind == "Receiver") | .spec.resources[] | select(.kind == "ImageRepository") | .namespace + "/" + .name' | \
    grep -v '^---$' | sort | uniq
}

echo "Validating webhook receiver configuration..."
echo

# Get the lists
REPOS_IN_APPS=$(get_image_repositories_from_apps)
REPOS_IN_RECEIVER=$(get_image_repositories_from_receiver)

# Find missing repositories (in apps but not in receiver)
MISSING=$(comm -23 <(echo "$REPOS_IN_APPS") <(echo "$REPOS_IN_RECEIVER"))

# Find extra repositories (in receiver but not in apps)
EXTRA=$(comm -13 <(echo "$REPOS_IN_APPS") <(echo "$REPOS_IN_RECEIVER"))

# Report results
if [ -z "$MISSING" ] && [ -z "$EXTRA" ]; then
  echo -e "${GREEN}✓ All ImageRepositories are correctly registered in the webhook receiver${RESET}"
  exit 0
fi

exit_code=0

if [ -n "$MISSING" ]; then
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${RED}ERROR: ImageRepositories missing from webhook receiver!${RESET}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo
  echo -e "${RED}The following ImageRepositories will NOT receive webhook updates:${RESET}"
  echo
  while IFS= read -r repo; do
    [ -n "$repo" ] && echo -e "  ${RED}✗ $repo${RESET}"
  done <<< "$MISSING"
  echo
  echo -e "${RED}To fix: Add these to infrastructure/base/configs/image-scanning-webhook-receiver/all.yaml${RESET}"
  echo -e "${RED}under the Receiver resource's spec.resources list${RESET}"
  echo
  exit_code=1
fi

if [ -n "$EXTRA" ]; then
  echo -e "${YELLOW}WARNING: Extra ImageRepositories in webhook receiver${RESET}"
  echo
  echo -e "${YELLOW}The following are registered but don't exist:${RESET}"
  echo
  while IFS= read -r repo; do
    [ -n "$repo" ] && echo -e "  ${YELLOW}✗ $repo${RESET}"
  done <<< "$EXTRA"
  echo
  echo -e "${YELLOW}Consider removing these from infrastructure/base/configs/image-scanning-webhook-receiver/all.yaml${RESET}"
  echo
fi

exit "$exit_code"

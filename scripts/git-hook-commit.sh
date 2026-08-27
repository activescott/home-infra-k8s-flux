#!/usr/bin/env bash
set -euo pipefail

# When running as a hook, we're in .git/hooks/, so need to go up two levels
# When running directly, we're in scripts/, so need to go up one level
this_dir=$(cd $(dirname "$0"); pwd)
repo_dir=$(git rev-parse --show-toplevel)

# git exports GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE to hooks. kustomize shells out to
# git when a kustomization references a remote base (e.g. arize-phoenix), and with
# these vars inherited that git operates on THIS repo instead of kustomize's temp
# clone — its checkout then aborts with "Your local changes ... would be overwritten".
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

kubectl_context=nas

# the goal here is just to make sure at minimum kubectl kustomize processes all the yaml
check_kustomize() {
  local dir=$1
  local output
  output=$(kubectl --context $kubectl_context kustomize "$dir" --enable-helm)
  local line_count=$(echo "$output" | wc -l)

  if [ -z "$output" ] || [ $line_count -eq 0 ]; then
    echo "Error: kubectl kustomize produced no output for $dir"
    exit 1
  fi

  echo "kustomize succeeded for $dir! Final line count: $line_count"

  # stash apps/production's resolved output for check-persistent-mounts.mts below,
  # so it doesn't need to re-resolve kustomize (and re-fetch remote bases) itself
  if [ "$dir" = "${repo_dir}/apps/production" ]; then
    APPS_PRODUCTION_YAML="$output"
  fi
}

# Check the trees Flux builds
check_kustomize "${repo_dir}/apps/production"
check_kustomize "${repo_dir}/infrastructure/prod/configs"
# DNS records are Crossplane managed resources under `prune: true`, so a kustomize
# error that drops a record from the build output deletes the real record from
# Cloudflare. Cheap to catch here.
check_kustomize "${repo_dir}/infrastructure/prod/dns"

# check-persistent-mounts.mts is TypeScript run via Node's native type
# stripping — select the pinned version through nvm rather than assuming the
# caller's shell already has it (git hooks often run with a minimal PATH).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use "$(cat "${repo_dir}/scripts/.nvmrc")" >/dev/null
else
  echo "Warning: nvm not found at $NVM_DIR; falling back to system node for check-persistent-mounts.mts" >&2
fi

echo ""
echo "$APPS_PRODUCTION_YAML" \
  | yq -o=json ea '[select(.kind == "StatefulSet" or .kind == "Deployment")]' - \
  | "${repo_dir}/scripts/check-persistent-mounts.mts"

# Validate webhook receiver configuration (non-blocking, just warns)
echo ""
"${repo_dir}/scripts/validate-webhook-receiver.sh" || true

exit 0

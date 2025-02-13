#!/usr/bin/env bash
set -euo pipefail

this_dir=$(cd $(dirname "$0"); pwd)
parent_dir=$(cd "$this_dir/.."; pwd)
repo_dir=$(cd "$parent_dir"; pwd)

# the goal here is just to make sure at minimum kubectl kustomize processes all the yaml
check_kustomize() {
  local dir=$1
  local line_count=$(kubectl kustomize "$dir" | wc -l)

  if [ $? -ne 0 ]; then
    echo "Error: kubectl kustomize failed for $dir"
    exit 1
  else 
    echo "kustomize succeeded for $dir! Final line count: $line_count"
  fi
}

# Check both directories
check_kustomize "${repo_dir}/apps/production"
check_kustomize "${repo_dir}/infrastructure/prod/configs"

exit 0

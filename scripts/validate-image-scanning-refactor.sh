#!/usr/bin/env bash
set -euo pipefail

# Script to validate that image-scanning refactor produces identical outputs
# Usage: ./validate-image-scanning-refactor.sh [before|after|compare]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/.validation-outputs"

APPS=(
  "coinpoet"
  "scott-willeke-com"
  "ramblefeed"
  "tayle"
)

capture_outputs() {
  local phase=$1
  local output_subdir="$OUTPUT_DIR/$phase"

  echo "Capturing kustomize outputs for phase: $phase"
  mkdir -p "$output_subdir"

  for app in "${APPS[@]}"; do
    local app_dir="$REPO_ROOT/apps/production/$app"
    echo "  - Processing $app..."

    if [ ! -d "$app_dir" ]; then
      echo "    WARNING: Directory not found: $app_dir"
      continue
    fi

    # Capture the full kustomize build output
    kubectl kustomize "$app_dir" > "$output_subdir/${app}.yaml" 2>&1 || {
      echo "    ERROR: Failed to kustomize $app"
      continue
    }

    echo "    ✓ Saved to $output_subdir/${app}.yaml"
  done

  echo "✓ Capture complete for phase: $phase"
}

compare_outputs() {
  echo "Comparing before and after outputs..."
  local before_dir="$OUTPUT_DIR/before"
  local after_dir="$OUTPUT_DIR/after"
  local diff_dir="$OUTPUT_DIR/diffs"

  if [ ! -d "$before_dir" ]; then
    echo "ERROR: Before outputs not found. Run with 'before' first."
    exit 1
  fi

  if [ ! -d "$after_dir" ]; then
    echo "ERROR: After outputs not found. Run with 'after' first."
    exit 1
  fi

  mkdir -p "$diff_dir"

  local all_match=true

  for app in "${APPS[@]}"; do
    echo "  - Comparing $app..."

    local before_file="$before_dir/${app}.yaml"
    local after_file="$after_dir/${app}.yaml"
    local diff_file="$diff_dir/${app}.diff"

    if [ ! -f "$before_file" ] || [ ! -f "$after_file" ]; then
      echo "    WARNING: Missing files for $app"
      all_match=false
      continue
    fi

    if diff -u "$before_file" "$after_file" > "$diff_file" 2>&1; then
      echo "    ✓ IDENTICAL"
      rm "$diff_file"
    else
      echo "    ✗ DIFFERENCES FOUND - see $diff_file"
      all_match=false
    fi
  done

  if $all_match; then
    echo "✓ All outputs are identical!"
    return 0
  else
    echo "✗ Some outputs differ. Check $diff_dir for details."
    return 1
  fi
}

# Main script logic
MODE="${1:-}"

case "$MODE" in
  before)
    capture_outputs "before"
    ;;
  after)
    capture_outputs "after"
    ;;
  compare)
    compare_outputs
    ;;
  *)
    echo "Usage: $0 [before|after|compare]"
    echo ""
    echo "  before   - Capture current kustomize outputs (before refactor)"
    echo "  after    - Capture new kustomize outputs (after refactor)"
    echo "  compare  - Compare before and after outputs"
    echo ""
    echo "Example workflow:"
    echo "  $0 before    # Capture baseline"
    echo "  # ... make changes ..."
    echo "  $0 after     # Capture new state"
    echo "  $0 compare   # Verify no changes"
    exit 1
    ;;
esac

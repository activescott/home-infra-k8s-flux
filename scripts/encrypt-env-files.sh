#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd)
parent_dir=$(cd "$this_dir/.."; pwd)
repo_dir=$(cd "$parent_dir"; pwd)

set -euo pipefail

usage() {
    echo "Usage: $0 <path> [<path> ...]"
    echo
    echo "Each <path> is either:"
    echo "  a directory — every .env* file in it (recursively) is encrypted, or"
    echo "  a single file — that one file is encrypted."
    echo
    echo "Paths are resolved against your current directory, not the repo root."
}

if [ $# -lt 1 ]; then
    usage
    exit 1
fi

# prepare for SOPS:
source "$this_dir/_sops_config.include.sh"

# Encrypt one file to <file>.encrypted. sops writes to a temp file that replaces the
# target only on success: redirecting straight into the target truncates it before sops
# runs, so a failure there would destroy the previous ciphertext, which for a file whose
# plaintext has already been deleted is the only copy left.
encrypt_file() {
  local file="$1"
  local encrypted_file="${file}.encrypted"
  local tmp_file="${encrypted_file}.tmp.$$"

  echo "Encrypting $file to $encrypted_file"
  if sops encrypt \
      --age "$age_key_public" \
      --input-type dotenv \
      --output-type dotenv \
      "$file" > "$tmp_file"; then
    mv "$tmp_file" "$encrypted_file"
  else
    rm -f "$tmp_file"
    echo "Error: sops failed on $file; left $encrypted_file unchanged"
    return 1
  fi
}

count=0
for target in "$@"; do
  if [ -d "$target" ]; then
    echo "Encrypting .env files in $target"
    # -print0 and read -d '' rather than $(find ...) in an array: the unquoted command
    # substitution splits on whitespace, so a path containing a space became two bad paths.
    while IFS= read -r -d '' file; do
      encrypt_file "$file"
      count=$((count + 1))
    done < <(find "$target" -type f -name ".env*" ! -name "*.encrypted" -print0)
  elif [ -f "$target" ]; then
    if [[ "$target" == *".encrypted" ]]; then
      echo "Error: $target is already encrypted; pass the plaintext file instead"
      exit 1
    fi
    encrypt_file "$target"
    count=$((count + 1))
  else
    echo "Error: no such file or directory: $target"
    exit 1
  fi
done

echo "Encrypted $count file(s)"

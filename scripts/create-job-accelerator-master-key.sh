#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
parent_dir=$(cd $(dirname "$this_dir"); pwd) # parent directory

#-e: Exits immediately if any command returns a non-zero status (i.e., fails)
#-u: Treats unset variables as errors and exits immediately
#-o pipefail: If any command in a pipeline fails, the entire pipeline fails
set -euo pipefail

usage() {
  echo "Usage: $0 [--force] [<repo-dir>]"
  echo
  echo "Generates job-accelerator's master key (KEK) and encrypts it to the age recipient,"
  echo "with no plaintext anywhere, into:"
  echo "  $key_file"
  echo
  echo "Needs no private key: it encrypts to the recipient already recorded in the encrypted"
  echo "files in that directory. <repo-dir> defaults to the repo this script is in."
  echo
  echo "--force overwrites an existing key. THIS DESTROYS DATA. The master key wraps every"
  echo "client's data key; replacing it makes every key file in the keystore unreadable, and"
  echo "the app refuses to start rather than serve garbage. Adding a key alongside the old"
  echo "one is the rotation path, not this script."
  echo "See apps/production/job-accelerator/README.md#master-key"
}

# The `.public-key-encrypted` before the `.encrypted` marks a secret with no plaintext copy
# anywhere: scripts/onepassword-secrets.mts reads it and stops looking for one to back up.
app_dir="apps/production/job-accelerator"
key_file="$app_dir/.env.secret.master-key.public-key-encrypted.encrypted"

force=0
args=()
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) usage; exit 1 ;;
    *) args+=("$arg") ;;
  esac
done
if [ "${#args[@]}" -gt 1 ]; then
  usage
  exit 1
fi

repo_dir=$(cd "${args[0]:-$parent_dir}"; pwd)

for tool in sops age openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: $tool not found. Install it (e.g. brew install $tool) and rerun." >&2
    exit 1
  fi
done

# Overwriting is the one mistake this script can make that no rollback fixes, so it is a
# separate opt-in rather than a prompt.
if [ -f "$repo_dir/$key_file" ] && [ "$force" -ne 1 ]; then
  echo "Error: $key_file already exists." >&2
  echo >&2
  echo "That file is the only copy of the key that wraps every client's data key. Replacing" >&2
  echo "it makes the whole keystore unreadable. Pass --force only if you are certain the" >&2
  echo "keystore is empty (no files under /mnt/thedatapool/job-accelerator-keys)." >&2
  exit 1
fi

# The recipient comes from the encrypted files already in the app's directory rather than
# from _sops_config.include.sh, which refuses to run without the private key file. Anything
# other than exactly one recipient, identical across those files, means the directory is not
# what this script expects.
recipient=""
shopt -s nullglob
existing=("$repo_dir/$app_dir"/.env.secret.*.encrypted)
shopt -u nullglob
if [ "${#existing[@]}" -eq 0 ]; then
  echo "Error: no .env.secret.*.encrypted files in $app_dir to read the recipient from" >&2
  exit 1
fi
for file in "${existing[@]}"; do
  file_recipients=$(sed -n 's/^sops_age__list_[0-9]*__map_recipient=//p' "$file")
  if [ "$(printf '%s\n' "$file_recipients" | grep -c .)" -ne 1 ]; then
    echo "Error: expected exactly one age recipient in $file" >&2
    exit 1
  fi
  if [ -n "$recipient" ] && [ "$file_recipients" != "$recipient" ]; then
    echo "Error: the files in $app_dir are encrypted to different recipients" >&2
    exit 1
  fi
  recipient="$file_recipients"
done

# sops never shells out to age, so this is the only use of the binary: age rejects a
# malformed recipient here, before the key is generated.
if ! age -r "$recipient" -o /dev/null </dev/null; then
  echo "Error: $recipient is not a valid age recipient" >&2
  exit 1
fi

# Written to a temp file beside the target and moved into place only once the encryption
# succeeds, so a failure leaves any previous file intact. The temp file holds ciphertext only.
key_tmp="$repo_dir/$key_file.tmp.$$"
trap 'rm -f "$key_tmp"' EXIT

# 32 bytes, base64: the app decodes MASTER_KEY_<n> and refuses to start unless it is exactly
# 32 bytes (packages/web-app/app/lib/crypto/master-key.ts). The key lives in a shell variable
# and reaches sops on stdin. printf is a builtin, so the value never appears in a process's
# argv, and nothing writes it to disk.
master_key=$(openssl rand -base64 32)

printf 'MASTER_KEY_1=%s\n' "$master_key" | sops encrypt \
  --age "$recipient" \
  --input-type dotenv \
  --output-type dotenv \
  --filename-override "$key_file" > "$key_tmp"
mv "$key_tmp" "$repo_dir/$key_file"

cat <<EOF
Wrote the master key to:
  $repo_dir/$key_file

Encrypted to: $recipient

Nobody knows this value and there is no other copy. Losing the file loses every client's
encrypted data, since it is what unwraps the keys in the keystore.

To deploy, commit it on a branch, push, and open a PR:

  git add $key_file
  git commit -m "Add job-accelerator master key"
  git push -u origin HEAD

MASTER_KEY_ACTIVE is set to 1 as plain env in apps/base/job-accelerator/app-deployment.yaml.
See apps/production/job-accelerator/README.md#master-key.
EOF

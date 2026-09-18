#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
parent_dir=$(cd $(dirname "$this_dir"); pwd) # parent directory

#-e: Exits immediately if any command returns a non-zero status (i.e., fails)
#-u: Treats unset variables as errors and exits immediately
#-o pipefail: If any command in a pipeline fails, the entire pipeline fails
set -euo pipefail

usage() {
  echo "Usage: $0 [<repo-dir>]"
  echo
  echo "Generates a new token for the Alertmanager -> OpenClaw gateway hook and encrypts it"
  echo "into both files that hold it, so they always match:"
  echo "  $alertmanager_file"
  echo "  $olya_file"
  echo
  echo "Needs no private key: it encrypts to the age recipient already recorded in those"
  echo "files. <repo-dir> defaults to the repo this script is in."
  echo "See apps/production/olya/README.md#alertmanager-hook-token"
}

alertmanager_file="apps/production/monitoring/prometheus/.env.secret.alertmanager-olya-hook.encrypted"
olya_file="apps/production/olya/.env.secret.olya-hooks.encrypted"

if [ $# -gt 1 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 1
fi

repo_dir=$(cd "${1:-$parent_dir}"; pwd)

for tool in sops age openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: $tool not found. Install it (e.g. brew install $tool) and rerun." >&2
    exit 1
  fi
done

# The recipient comes from the files being replaced rather than _sops_config.include.sh,
# which refuses to run without the private key file. Anything other than exactly one
# recipient, identical in both files, means the files are not what this script expects.
recipient=""
for file in "$alertmanager_file" "$olya_file"; do
  if [ ! -f "$repo_dir/$file" ]; then
    echo "Error: $repo_dir/$file not found" >&2
    exit 1
  fi
  file_recipients=$(sed -n 's/^sops_age__list_[0-9]*__map_recipient=//p' "$repo_dir/$file")
  if [ "$(printf '%s\n' "$file_recipients" | grep -c .)" -ne 1 ]; then
    echo "Error: expected exactly one age recipient in $file" >&2
    exit 1
  fi
  if [ -n "$recipient" ] && [ "$file_recipients" != "$recipient" ]; then
    echo "Error: $alertmanager_file and $olya_file are encrypted to different recipients" >&2
    exit 1
  fi
  recipient="$file_recipients"
done

# sops never shells out to age, so this is the only use of the binary: age rejects a
# malformed recipient here, before either file is touched.
if ! age -r "$recipient" -o /dev/null </dev/null; then
  echo "Error: $recipient is not a valid age recipient" >&2
  exit 1
fi

# Each file is written to a temp file beside it and both are moved into place only once
# both encryptions succeed, so a failure leaves the old pair intact and matching. The temp
# files hold ciphertext only.
alertmanager_tmp="$repo_dir/$alertmanager_file.tmp.$$"
olya_tmp="$repo_dir/$olya_file.tmp.$$"
trap 'rm -f "$alertmanager_tmp" "$olya_tmp"' EXIT

# The token lives in a shell variable and reaches sops on stdin. printf is a builtin, so the
# value never appears in a process's argv, and nothing writes it to disk.
token=$(openssl rand -hex 32)

encrypt_token() {
  printf 'openclaw_hooks_token=%s\n' "$token" | sops encrypt \
    --age "$recipient" \
    --input-type dotenv \
    --output-type dotenv \
    --filename-override "$1" > "$2"
}

encrypt_token "$alertmanager_file" "$alertmanager_tmp"
encrypt_token "$olya_file" "$olya_tmp"
mv "$alertmanager_tmp" "$repo_dir/$alertmanager_file"
mv "$olya_tmp" "$repo_dir/$olya_file"

cat <<EOF
Rotated the hook token in:
  $repo_dir/$alertmanager_file
  $repo_dir/$olya_file

Encrypted to: $recipient

To deploy, commit both files in one commit on a branch, push, and open a PR:

  git add $alertmanager_file $olya_file
  git commit -m "Rotate olya hook token"
  git push -u origin HEAD

Alert notifications to Olya can fail for a minute or two after Flux applies it. See
apps/production/olya/README.md#alertmanager-hook-token.
EOF

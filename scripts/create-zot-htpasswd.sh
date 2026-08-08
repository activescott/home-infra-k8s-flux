#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
parent_dir=$(cd $(dirname "$this_dir"); pwd) # parent directory
repo_dir=$(cd "$parent_dir"; pwd) # repository directory

#-e: Exits immediately if any command returns a non-zero status (i.e., fails)
#-u: Treats unset variables as errors and exits immediately
#-o pipefail: If any command in a pipeline fails, the entire pipeline fails
set -eo pipefail

if ! command -v htpasswd >/dev/null 2>&1; then
  echo "Error: htpasswd not found (macOS ships one at /usr/sbin/htpasswd; on Linux install apache2-utils/httpd-tools)."
  exit 1
fi

# Regenerates BOTH accounts every run. This is simpler than supporting
# single-account rotation, at the cost of needing to re-`docker login`
# everywhere the other account's password was used too - acceptable since
# this is a small, internal set of consumers (CI runners, kind nodes).
ci_password=$(openssl rand -base64 24)
mirror_password=$(openssl rand -base64 24)

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

htpasswd_file="$tmpdir/htpasswd"
# htpasswd -n emits a trailing blank line after each entry on some platforms
# (confirmed on macOS) - filter those out so the file is exactly two
# "user:hash" lines with no blank lines in between.
{
  htpasswd -nbB ci "$ci_password"
  htpasswd -nbB mirror "$mirror_password"
} | awk 'NF' > "$htpasswd_file"

# Encrypted as BINARY (not JSON/dotenv): the generator key "htpasswd" has no
# recognized extension, so Flux's kustomize-controller decrypts it via the
# binary format, which round-trips the raw multi-line file untouched - the
# JSON/dotenv sops formats can't represent multiple "user:hash" lines cleanly.
htpasswd_file_encrypted="$repo_dir/apps/production/zot/zot-htpasswd.encrypted"

# Prepare for sops:
source "$this_dir/_sops_config.include.sh"

sops -encrypt \
  --age "$age_key_public" \
  --input-type=binary \
  --output-type=binary "$htpasswd_file" > "$htpasswd_file_encrypted"

cat <<EOF
The encrypted zot htpasswd file has been saved to:
  ${htpasswd_file_encrypted}

SAVE THESE TWO PASSWORDS TO 1PASSWORD NOW - they cannot be recovered from
the encrypted file afterward:

  ci:     ${ci_password}
  mirror: ${mirror_password}

Sanity-check the round-trip before committing:
  SOPS_AGE_KEY_FILE=$repo_dir/home-infra-private.agekey \\
    sops -d --input-type binary --output-type binary ${htpasswd_file_encrypted}
  # expect two lines: ci:\$2y\$...  and  mirror:\$2y\$...

To deploy, commit and push:

  git add apps/production/zot/zot-htpasswd.encrypted
  git commit -m "rotate zot htpasswd accounts"
  git push

Rotating means re-\`docker login\` everywhere the old passwords were used
(CI runner pods, kind clusters, local machines).
EOF

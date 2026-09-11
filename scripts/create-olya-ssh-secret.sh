#!/usr/bin/env bash
this_dir=$(cd $(dirname "$0"); pwd) # this script's directory
parent_dir=$(cd $(dirname "$this_dir"); pwd) # parent directory
repo_dir=$(cd "$parent_dir"; pwd) # repository directory

#-e: Exits immediately if any command returns a non-zero status (i.e., fails)
#-u: Treats unset variables as errors and exits immediately
#-o pipefail: If any command in a pipeline fails, the entire pipeline fails
set -eo pipefail

usage() {
  echo "Usage: $0 <path-to-private-key>"
  echo
  echo "Encrypts Olya's ed25519 SSH private key for the olya StatefulSet."
  echo "The plaintext key is NOT copied into the repo and NOT deleted - it is read"
  echo "from wherever you exported it (e.g. a 1Password download in ~/Downloads),"
  echo "and you remove that copy yourself afterward."
  echo
  echo "scripts/encrypt-env-files.sh cannot be used here: it is dotenv-only, and a"
  echo "PEM private key is multi-line so it needs the binary sops format."
}

if [ $# -ne 1 ]; then
  usage
  exit 1
fi

key_file="$1"

if [ ! -r "$key_file" ]; then
  echo "Error: cannot read $key_file" >&2
  exit 1
fi

# Fail loudly on the two easy mistakes: handing this the public key, or handing it a
# key in some other format. Checked with ssh-keygen rather than by grepping the file so
# an encrypted-at-rest key is also rejected (it would be useless in the container, which
# has no way to supply a passphrase).
if ! ssh-keygen -y -P "" -f "$key_file" >/dev/null 2>&1; then
  echo "Error: $key_file is not an unencrypted OpenSSH private key." >&2
  echo "  - If you passed the .pub file, pass the private half instead." >&2
  echo "  - If the key has a passphrase, export a passphrase-free copy: the pod has" >&2
  echo "    no way to enter one." >&2
  exit 1
fi

fingerprint=$(ssh-keygen -lf "$key_file" | awk '{print $2}')

# Encrypted as BINARY (not JSON/dotenv): the generator key "id_ed25519" has no
# recognized extension, so Flux's kustomize-controller decrypts it via the binary
# format, which round-trips the multi-line PEM untouched.
#
# Plaintext naming matters: a file named "id_ed25519" matches nothing in .gitignore and
# would be committable. The ".secret" suffix is covered by the existing "*.secret" rule,
# while "*.secret.encrypted" matches no ignore rule and so stays committable.
key_file_encrypted="$repo_dir/apps/production/olya/olya-ssh.secret.encrypted"

# Prepare for sops:
source "$this_dir/_sops_config.include.sh"

sops -encrypt \
  --age "$age_key_public" \
  --input-type=binary \
  --output-type=binary "$key_file" > "$key_file_encrypted"

cat <<EOF
The encrypted key has been saved to:
  ${key_file_encrypted}

Key fingerprint: ${fingerprint}
  Confirm this matches the Authentication key AND the Signing key registered on
  https://github.com/settings/keys for the olyapop account. They are two separate
  entries there; commit verification fails silently if only the first exists.

Sanity-check the round-trip before committing. ssh-keygen refuses a private key on
stdin and refuses /dev/fd from process substitution (it enforces 0600 on the path), so
this decrypts to a mode-0600 temp file and shreds it:

  tmp=\$(mktemp) && chmod 600 "\$tmp" \\
    && trap 'rm -P "\$tmp" 2>/dev/null || rm -f "\$tmp"' EXIT \\
    && SOPS_AGE_KEY_FILE=$repo_dir/home-infra-private.agekey \\
       sops -d --input-type binary --output-type binary ${key_file_encrypted} > "\$tmp" \\
    && ssh-keygen -lf "\$tmp" && ssh-keygen -y -P "" -f "\$tmp"
  # expect fingerprint ${fingerprint}, and a public key matching the one on olyapop

Now delete your plaintext copy:
  rm -P ${key_file}

To deploy, commit and push:

  git add apps/production/olya/olya-ssh.secret.encrypted
  git commit -m "add olya ssh key"
  git push
EOF

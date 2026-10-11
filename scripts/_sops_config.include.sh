# Sets age_key_public to the age recipient every *.encrypted file in this repo is
# encrypted to. It is declared once, in the repo's root .sops.yaml; this reads it from
# there so the shell scripts that source this file never name it themselves.
#
# Encrypting needs only this public key, so every script that sources this file works on a
# machine with no private key at all. Decrypting reads the private key from 1Password:
#
#   ./scripts/onepassword-secrets.mts show <file>
#   ./scripts/onepassword-secrets.mts edit <file>
age_key_public=$(sed -n -E \
  's/^[[:space:]]*(-[[:space:]]+)?age:[[:space:]]*(age1[0-9a-z]+)[[:space:]]*$/\2/p' \
  "$(dirname "${BASH_SOURCE[0]}")/../.sops.yaml")
if [[ $age_key_public != age1* || $age_key_public == *$'\n'* ]]; then
  echo "ERROR: expected exactly one age: recipient in .sops.yaml" >&2
  exit 1
fi

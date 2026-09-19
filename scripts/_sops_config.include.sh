# The age recipient every *.encrypted file in this repo is encrypted to. This line is the
# single declaration of it; `./scripts/onepassword-secrets.mts rotate-age-key` rewrites it
# and nothing else names it.
#
# Encrypting needs only this public key, so every script that sources this file works on a
# machine with no private key at all. Decrypting reads the private key from 1Password:
#
#   ./scripts/onepassword-secrets.mts show <file>
#   ./scripts/onepassword-secrets.mts edit <file>
#
# NOTE: this is the public key corresponding to the private key in 1Password.
age_key_public="age1nur86m07v4f94xpc8ugg0cmum9fpyp3hcha2cya6x09uphu4zg5szrtzgt"

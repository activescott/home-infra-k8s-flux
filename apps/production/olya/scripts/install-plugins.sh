#!/bin/sh
# Installs managed plugins listed in /cfg/managed-plugins.txt.
# Idempotent: skips plugins whose trust record already exists.
set -eu

plugins_file="/cfg/managed-plugins.txt"
if [ ! -f "$plugins_file" ]; then
  echo "install-plugins: no $plugins_file found; nothing to install"
  exit 0
fi

while IFS= read -r spec || [ -n "$spec" ]; do
  case "$spec" in ''|\#*) continue ;; esac
  # Extract the short plugin id from the spec (e.g. @openclaw/acpx@2026.9.4 -> acpx)
  id="${spec%%@[0-9]*}"
  id="${id##*/}"
  if openclaw plugins inspect "$id" --json 2>/dev/null \
     | grep -q '"reason":"record-missing"'; then
    echo "install-plugins: $id trust record missing; installing $spec"
    openclaw plugins install "$spec" --accept-capabilities
  else
    echo "install-plugins: $id trust record present; skipping"
  fi
done < "$plugins_file"

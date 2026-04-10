#!/usr/bin/env bash
# Dump the photoprism MariaDB databases for both tenants (scott and oksana)
# to a local backup directory. Useful before upgrades or any time you want a
# quick logical backup.
#
# Usage: ./backup-mariadb.sh [output-dir]
#   Default output-dir: ~/photoprism-backups
set -euo pipefail

OUT_DIR="${1:-$HOME/photoprism-backups}"
KCTX="${KUBECTL_CONTEXT:-nas}"
TS=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUT_DIR"

for ns in photoprism-scott photoprism-oksana; do
  out="$OUT_DIR/photoprism-${ns}-${TS}.sql"
  echo "=== Dumping $ns -> $out ==="
  kubectl --context "$KCTX" exec -n "$ns" mariadb-0 -- \
    sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --triggers "$MARIADB_DATABASE"' \
    > "$out"
  bytes=$(wc -c < "$out")
  tables=$(grep -c '^CREATE TABLE' "$out" || true)
  echo "  wrote ${bytes} bytes, ${tables} CREATE TABLE statements"
  if [ "$bytes" -lt 1024 ] || [ "$tables" -lt 1 ]; then
    echo "ERROR: dump for $ns looks empty or invalid" >&2
    exit 1
  fi
done

echo
echo "Backups written to $OUT_DIR:"
ls -lh "$OUT_DIR"/photoprism-*-"${TS}".sql

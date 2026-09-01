#!/bin/bash
# Page through every Email on the server and write one Message-ID per line.
# Email/query returns ids by position; Email/get resolves them to messageId.
set -euo pipefail

url="https://mail.activescott.com/jmap/"
user="scott@willeke.com"
# Read from a 0600 file rather than an inline literal, so the value never reaches
# shell history. Mint a fresh app password in the Stalwart UI -- the Phase 9 one
# was revoked 2026-09-01. Note "accountId" below is also environment-specific.
pw="$(cat "${STALWART_PW_FILE:?set STALWART_PW_FILE to a 0600 file holding a Stalwart app password}")"
out="/tmp/srv-mids.txt"
batch=500

: > "$out"
off=0
while :; do
  ids=$(curl -s -u "$user:$pw" -H 'Content-Type: application/json' -X POST "$url" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"d\",\"position\":$off,\"limit\":$batch},\"0\"]]}" \
    | jq -c '.methodResponses[0][1].ids')

  [ "$ids" = "[]" ] || [ "$ids" = "null" ] && break

  curl -s -u "$user:$pw" -H 'Content-Type: application/json' -X POST "$url" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/get\",{\"accountId\":\"d\",\"ids\":$ids,\"properties\":[\"messageId\"]},\"0\"]]}" \
    | jq -r '.methodResponses[0][1].list[] | (.messageId[0] // "NONE")' >> "$out"

  off=$((off + batch))
  [ $((off % 10000)) -eq 0 ] && echo "  ...$off" >&2
done

echo "wrote $(wc -l < "$out") message-ids" >&2

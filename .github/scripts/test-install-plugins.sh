#!/usr/bin/env bash
# Runs apps/production/olya/scripts/install-plugins.mts in the olya image the way the
# install-plugins initContainer does, against a /state volume in each state it meets on a boot.
# Usage: test-install-plugins.sh <image> <docker memory limit, e.g. 2g>
set -euo pipefail

image=$1
mem=$2
olya=$PWD/apps/production/olya
# Under RUNNER_TEMP because files here are bind-mounted, and the runner's Docker daemon shares
# its work volume but not its /tmp.
work=$(mktemp -d -p "${RUNNER_TEMP:-/tmp}")
failures=0
# The pod's hostname. OpenClaw only reclaims a SIGKILLed process's startup-migration lease when
# the hostname matches, and otherwise waits out its 5-minute TTL. Docker's random hostnames
# would make every run after a killed one fail where the pod would not.
host=olya-0

# The pod mounts these from the olya-scripts ConfigMap with defaultMode 0555; git keeps them 0644.
cp -r "$olya/scripts" "$work/scripts"
chmod 0555 "$work"/scripts/*

# Lines starting with "-" remove a managed install rather than pin one.
mapfile -t specs < <(grep -vE '^\s*(#|-|$)' "$olya/managed-plugins.txt")

plugin_id() { sed -E 's/@[0-9].*$//; s#^.*/##' <<<"$1"; }
plugin_version() { sed -nE 's/^.*@([0-9][^@]*)$/\1/p' <<<"$1"; }

fail() {
  echo "::error::$*"
  failures=$((failures + 1))
}

default_config='{"plugins":{"allow":["acpx"],"entries":{"acpx":{"enabled":true}}}}'

new_volume() {
  local vol=ip-test-$1-$RANDOM config=${2:-$default_config}
  docker volume create "$vol" >/dev/null
  # The PVC is chowned to 1000 on the NAS and seed-workspace has published openclaw.json by
  # the time install-plugins runs. The real one lives in the private activeassistant repo; the
  # default keeps the part of its plugins block that names acpx. acpx is deliberately not in its
  # load.paths, so the baked copy under /opt/olya/plugins is invisible to inspect there too.
  docker run --rm -u 0 -v "$vol:/state" -e "CONFIG=$config" --entrypoint sh "$image" -c '
    mkdir -p /state/home /state/openclaw /state/config &&
    printf "%s\n" "$CONFIG" > /state/config/openclaw.json &&
    chown -R 1000:1000 /state' >/dev/null
  echo "$vol"
}

copy_volume() {
  local dst
  dst=$(new_volume "$2")
  docker run --rm -u 0 -v "$1:/from:ro" -v "$dst:/to" --entrypoint sh "$image" \
    -c 'rm -rf /to/* && cp -a /from/. /to/' >/dev/null
  echo "$dst"
}

# Same securityContext, env and mounts as the initContainer. /tmp is a volume rather than
# --tmpfs because the pod's /tmp is a disk-backed emptyDir, and tmpfs pages would be charged
# against the memory limit.
run_install() {
  local vol=$1 limit=$2 cfg=$3 log=$4 name=ip-test-run-$RANDOM
  local tmpvol=$name-tmp
  docker volume create "$tmpvol" >/dev/null
  docker run --rm -u 0 -v "$tmpvol:/tmp" --entrypoint chmod "$image" 1777 /tmp
  local start=$SECONDS
  set +e
  docker run --name "$name" --hostname "$host" \
    --memory "$limit" --memory-swap "$limit" --cpus 1 \
    --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
    -e HOME=/state/home \
    -e OPENCLAW_STATE_DIR=/state/openclaw \
    -e OPENCLAW_CONFIG_PATH=/state/config/openclaw.json \
    -v "$vol:/state" -v "$tmpvol:/tmp" \
    -v "$cfg:/cfg/managed-plugins.txt:ro" \
    -v "$work/scripts:/scripts:ro" \
    --entrypoint sh "$image" -c '
      /scripts/install-plugins.mts; rc=$?
      peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null) && echo "test: memory.peak $((peak / 1048576))Mi"
      exit $rc' 2>&1 | tee "$log"
  RUN_EXIT=${PIPESTATUS[0]}
  set -e
  RUN_OOM=$(docker inspect -f '{{.State.OOMKilled}}' "$name")
  echo "test: exit $RUN_EXIT, OOMKilled $RUN_OOM, $((SECONDS - start))s at --memory $limit"
  docker rm "$name" >/dev/null
  docker volume rm "$tmpvol" >/dev/null
}

installed_version() {
  docker run --rm --hostname "$host" --user 1000:1000 \
    -e HOME=/state/home \
    -e OPENCLAW_STATE_DIR=/state/openclaw \
    -e OPENCLAW_CONFIG_PATH=/state/config/openclaw.json \
    -v "$1:/state" --entrypoint openclaw "$image" plugins inspect "$2" --json \
    | tee /dev/stderr | yq -p json '.install.resolvedVersion // ""' || true
}

# Asserts one run: exit status, a log line proving which path ran, and that every plugin on the
# volume is at the version in expect_cfg.
check() {
  local label=$1 vol=$2 log=$3 expect_exit=$4 expect_line=$5 expect_cfg=$6
  [ "$RUN_EXIT" = "$expect_exit" ] || fail "$label: exit $RUN_EXIT, expected $expect_exit"
  grep -qE "$expect_line" "$log" || fail "$label: no log line matching /$expect_line/"
  while read -r spec; do
    local id want got
    id=$(plugin_id "$spec")
    want=$(plugin_version "$spec")
    got=$(installed_version "$vol" "$id")
    [ "$got" = "$want" ] || fail "$label: $id at '$got' after the run, expected $want"
  done < <(grep -vE '^\s*(#|-|$)' "$expect_cfg")
}

# The pinned paths must finish inside the initContainer's limit without falling back.
check_pinned() {
  check "$@" "$olya/managed-plugins.txt"
  [ "$RUN_OOM" = false ] || fail "$1: container OOMKilled at --memory $mem"
  grep -q "install-plugins: WARNING" "$3" && fail "$1: upgrade failed and fell back"
  return 0
}

# An older pin for each plugin: the release before the current one on npm.
older_cfg=$work/older.txt
: >"$older_cfg"
for spec in "${specs[@]}"; do
  pkg=$(sed -E 's/^npm://; s/@[0-9][^@]*$//' <<<"$spec")
  pinned=$(plugin_version "$spec")
  older=$(docker run --rm -e HOME=/tmp --entrypoint npm "$image" view "$pkg" versions --json \
    | yq -p json '.[]' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | awk -v p="$pinned" '$0 == p { print prev } { prev = $0 }' || true)
  [ -n "$older" ] || { echo "::error::no release of $pkg older than $pinned"; exit 1; }
  echo "test: $pkg older version $older"
  echo "${spec%@*}@$older" >>"$older_cfg"
done

echo "::group::fresh install (empty volume)"
fresh=$(new_volume fresh)
run_install "$fresh" "$mem" "$olya/managed-plugins.txt" "$work/fresh.log"
# With acpx enabled in config, inspect on an empty state dir installs the catalog version itself,
# which is the pin as long as the pin matches the image's OpenClaw. Either way it must end at the pin.
check_pinned fresh "$fresh" "$work/fresh.log" 0 "acpx (.*; installing|trust record present at .*; skipping)"
echo "::endgroup::"

echo "::group::skip (volume already at the pinned version)"
run_install "$fresh" "$mem" "$olya/managed-plugins.txt" "$work/skip.log"
check_pinned skip "$fresh" "$work/skip.log" 0 "present at .*; skipping"
grep -q "installing" "$work/skip.log" && fail "skip: reinstalled a plugin already at the pin"
echo "::endgroup::"

echo "::group::seed an older version"
older=$(new_volume older)
run_install "$older" "$mem" "$older_cfg" "$work/seed.log"
[ "$RUN_EXIT" = 0 ] || { echo "::error::could not seed the older version"; exit 1; }
older_copy=$(copy_volume "$older" fallback)
echo "::endgroup::"

echo "::group::version mismatch (volume at an older version)"
run_install "$older" "$mem" "$olya/managed-plugins.txt" "$work/mismatch.log"
check_pinned mismatch "$older" "$work/mismatch.log" 0 "installed version .* != pinned"
echo "::endgroup::"

# Not a state the pod meets on purpose: the container is starved of memory, which is how #203
# and #204 failed. At 256m inspect is OOMKilled before any install starts, so this takes the
# inspect-failed branch, not the failed-upgrade one. The pod must still boot on the older version.
echo "::group::failed upgrade falls back (older volume, 256m)"
run_install "$older_copy" 256m "$olya/managed-plugins.txt" "$work/fallback.log"
check fallback "$older_copy" "$work/fallback.log" 0 "install-plugins: WARNING .* failed .*; keeping" "$older_cfg"
echo "::endgroup::"

# How slack was on olya-0 after #241: loaded from a plugins.load.paths entry, so inspect reports
# origin config and trust record-missing with no npm project behind it. That must not pass for
# installed. The install fails here because the config copy overrides the managed one, and the
# pod must still boot with the copy it has.
echo "::group::untrusted copy (acpx loaded from a config path)"
untrusted=$(new_volume untrusted \
  '{"plugins":{"allow":["acpx"],"load":{"paths":["/opt/olya/plugins/acpx/node_modules/@openclaw/acpx"]},"entries":{"acpx":{"enabled":true}}}}')
run_install "$untrusted" "$mem" "$olya/managed-plugins.txt" "$work/untrusted.log"
[ "$RUN_EXIT" = 0 ] || fail "untrusted: exit $RUN_EXIT, expected 0"
grep -qE "acpx trust record-missing at .*; installing" "$work/untrusted.log" ||
  fail "untrusted: no log line saying the record-missing copy is being installed"
grep -q "acpx trust record present" "$work/untrusted.log" && fail "untrusted: skipped an untrusted copy"
echo "::endgroup::"

# A first install that fails with nothing installed to fall back on must not wedge the pod
# (Scott, 2026-09-24): exit 0, an ERROR line, and the failures file for the main container.
echo "::group::failed first install (no usable version)"
broken=$(new_volume broken)
broken_cfg=$work/broken.txt
echo "@openclaw/no-such-plugin-zzz@1.0.0" >"$broken_cfg"
run_install "$broken" "$mem" "$broken_cfg" "$work/broken.log"
[ "$RUN_EXIT" = 0 ] || fail "broken: exit $RUN_EXIT, expected 0"
grep -qE "install-plugins: ERROR no-such-plugin-zzz pinned 1\.0\.0 failed to install" "$work/broken.log" ||
  fail "broken: no ERROR line naming the plugin and pinned version"
docker run --rm --user 1000:1000 -v "$broken:/state" --entrypoint cat "$image" \
  /state/openclaw/install-plugins-failures.json >"$work/broken.json" || true
[ "$(yq -p json '.[0].plugin' "$work/broken.json")" = no-such-plugin-zzz ] ||
  fail "broken: failures file missing or does not name the plugin"
run_install "$broken" "$mem" "$olya/managed-plugins.txt" "$work/broken-clean.log"
docker run --rm --user 1000:1000 -v "$broken:/state" --entrypoint test "$image" \
  ! -e /state/openclaw/install-plugins-failures.json ||
  fail "broken: failures file still present after a clean run"
echo "::endgroup::"

# Each "-" line in managed-plugins.txt must remove a managed install of that package left on the
# PV by an earlier boot, leave the pinned plugins alone, and do nothing on the next boot.
mapfile -t removals < <(grep -E '^\s*-' "$olya/managed-plugins.txt" | sed -E 's/^\s*-//')
for removal in "${removals[@]}"; do
  pkg=$(sed -E 's/^npm://' <<<"$removal")
  id=$(plugin_id "$pkg")
  echo "::group::remove managed $pkg"
  retired=$(new_volume "retired-$id")
  # Seeded directly: once the image carries its own copy, install-plugins would skip it as trusted.
  docker run --rm --hostname "$host" --user 1000:1000 \
    -e HOME=/state/home \
    -e OPENCLAW_STATE_DIR=/state/openclaw \
    -e OPENCLAW_CONFIG_PATH=/state/config/openclaw.json \
    -v "$retired:/state" --entrypoint openclaw "$image" \
    plugins install "npm:$pkg@$(plugin_version "${specs[0]}")" --accept-capabilities --force
  [ "$(installed_version "$retired" "$id")" != "" ] || fail "remove $id: could not seed a managed install"
  run_install "$retired" "$mem" "$olya/managed-plugins.txt" "$work/retired-$id.log"
  # Without a bundled copy to take over, the managed one has to stay.
  if docker run --rm --entrypoint test "$image" -f "/app/dist/extensions/$id/openclaw.plugin.json"; then
    check_pinned "remove $id" "$retired" "$work/retired-$id.log" 0 "$id removed managed $pkg; now origin bundled"
    [ "$(installed_version "$retired" "$id")" = "" ] || fail "remove $id: managed install still recorded"
    run_install "$retired" "$mem" "$olya/managed-plugins.txt" "$work/retired-again-$id.log"
    grep -q "$id has no managed $pkg install; nothing to remove" "$work/retired-again-$id.log" ||
      fail "remove $id: second run did not report nothing to remove"
  else
    echo "test: $image has no bundled $id, so the managed install must be kept"
    check "keep $id" "$retired" "$work/retired-$id.log" 0 "WARNING $id has no bundled copy in this image; keeping managed $pkg" "$olya/managed-plugins.txt"
    [ "$(installed_version "$retired" "$id")" != "" ] || fail "keep $id: managed install removed with no bundled copy"
  fi
  docker volume rm "$retired" >/dev/null
  echo "::endgroup::"
done

docker volume rm "$fresh" "$older" "$broken" "$older_copy" "$untrusted" >/dev/null
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all install-plugins paths passed at --memory $mem"

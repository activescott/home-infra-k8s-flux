#!/usr/bin/env bash
# Sidecar loop. Pulls instruction files from origin/main every 5 minutes.
set -euo pipefail

state=/state
export HOME="$state/home"
workspace="$state/workspace"

# Memory files, preserved across the reset. Must match seed-workspace.sh.
memory_paths=(MEMORY.md DREAMS.md USER.md IDENTITY.md memory)

log() {
  echo "$(date -Iseconds) ==> $1"
}

sync_once() {
  git -C "$workspace" fetch origin main

  local head origin
  head=$(git -C "$workspace" rev-parse HEAD)
  origin=$(git -C "$workspace" rev-parse origin/main)
  if [ "$head" = "$origin" ]; then
    return 0
  fi

  log "changes detected:"
  git -C "$workspace" diff --name-only HEAD origin/main | sed 's/^/    /'

  # Memory files live only as working-tree files until the hourly sync pushes
  # them, so they are copied aside before the reset destroys them.
  local saved
  saved=$(mktemp -d)
  for p in "${memory_paths[@]}"; do
    [ -e "$workspace/$p" ] && cp -a "$workspace/$p" "$saved/"
  done

  git -C "$workspace" checkout --force -B main origin/main
  git -C "$workspace" clean -ffdx

  for p in "${memory_paths[@]}"; do
    if [ -e "$saved/$p" ]; then
      rm -rf "$workspace/$p"
      cp -a "$saved/$p" "$workspace/$p"
    fi
  done
  rm -rf "$saved"

  # The running gateway read its config at startup from /state, not from the
  # workspace, so the fresh copy has to be put where it is actually read from.
  cp "$workspace/openclaw.json" "$state/openclaw/openclaw.json"

  # Same copies seed-workspace.sh makes at boot. Copies, not symlinks; see there.
  [ -f "$workspace/subagents/opencode/AGENTS.md" ] && \
    install -m 644 "$workspace/subagents/opencode/AGENTS.md" "$HOME/.config/opencode/AGENTS.md"
  [ -f "$workspace/subagents/claude/CLAUDE.md" ] && \
    install -m 644 "$workspace/subagents/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"

  log "synced workspace to $origin"
}

# Give the main container time to finish starting before the first fetch.
sleep 60

while true; do
  sync_once || log "sync failed, will retry"
  sleep 300
done

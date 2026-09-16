#!/usr/bin/env bash
# Runs as an initContainer on every pod start. Idempotent.
#
# Prepares the credential and workspace half of the volume.
#
# The volume holds two kinds of file and they get opposite treatment, which this script is what
# physically separates:
#
#   Instruction files (everything in the checkout except the memory paths below) and the gateway
#   config are DECLARATIVE. They are forced back to origin's tip on every boot, discarding local
#   commits and local edits, and they land under $workspace and $state/config -- the two paths
#   the olya container mounts READ-ONLY. They change only through a reviewed PR, and the mount is
#   what makes that true of the files she actually runs on rather than only of the branch in
#   GitHub. Before the read-only mounts existed, an agent-written skills/<name>/SKILL.md loaded
#   live and forever, was never committed by the sync job, and so was invisible in both git and
#   review; and on 2026-09-15 the live openclaw.json was hand-edited and crashed the gateway.
#
#   Memory files are NOT declarative. memory-core writes them continuously (memory-flush before
#   every compaction, a nightly dreaming sweep, observed-preference directives appended to
#   USER.md) and the hourly sync job is what gets them into git. They live at $memory_live, which
#   stays writable, and are reached from workspace root through symlinks planted below.
set -euo pipefail

state=/state
export HOME="$state/home"
workspace="$state/workspace"
# Paths INSIDE this directory are repo-relative, which is why the repo's own memory/ directory
# ends up at $memory_live/memory. Awkward to read, and deliberate: memory-sync.mts copies these
# paths straight into a fresh clone, so any rewriting here would have to be undone there.
memory_live="$state/memory"
config_live="$state/config"
ssh_key=/etc/olya-ssh/id_ed25519

mkdir -p "$HOME" "$state/openclaw" "$state/archive" "$state/repos" "$memory_live" "$config_live"

if [ ! -r "$ssh_key" ]; then
  echo "FATAL: ssh key not readable at $ssh_key" >&2
  exit 1
fi

# ssh MUST be pointed at this config explicitly, and every path inside it must be absolute.
#
# OpenSSH does not use $HOME to find ~/.ssh. It reads the home directory out of the passwd
# entry, and uid 1000 in this image is `node`, whose passwd home is /home/node -- which is on
# the read-only root filesystem and holds nothing. So without -F, ssh silently ignores
# everything written below and fails with "Host key verification failed", which reads like a
# bad known_hosts rather than a config it never opened. Verified with `ssh -G`: user,
# StrictHostKeyChecking and UserKnownHostsFile all came back as built-in defaults.
#
# -F fixes which file is read. It does NOT fix `~` INSIDE that file: tilde expansion also uses
# the passwd entry, so `UserKnownHostsFile ~/.ssh/known_hosts` still resolves to /home/node.
# Hence $HOME expanded at write time below, and absolute paths in olyapop/dotfiles' ssh/config.
export GIT_SSH_COMMAND="ssh -F $HOME/.ssh/config"

# Minimal ssh config, enough to clone the private dotfiles repo. Her dotfiles' script/setup
# installs the real one immediately afterward; this exists only to break the circular dependency
# of "the config needed to clone the repo that provides the config".
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cat > "$HOME/.ssh/config" <<EOF
Host github.com
  User git
  IdentityFile $ssh_key
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile $HOME/.ssh/known_hosts
EOF
chmod 600 "$HOME/.ssh/config"

# Pin github.com's host keys from its published metadata rather than ssh-keyscan. ssh-keyscan
# trusts whatever answers on port 22, which is trust-on-first-use over an unauthenticated
# channel; api.github.com is authenticated by TLS.
tmp_known=$(mktemp)
if curl -fsS --max-time 20 https://api.github.com/meta \
   | jq -r '.ssh_keys[] | "github.com " + .' > "$tmp_known" && [ -s "$tmp_known" ]; then
  install -m 600 "$tmp_known" "$HOME/.ssh/known_hosts"
elif [ -s "$HOME/.ssh/known_hosts" ]; then
  echo "WARNING: could not reach api.github.com; keeping existing known_hosts" >&2
else
  echo "FATAL: could not reach api.github.com and no known_hosts exists" >&2
  rm -f "$tmp_known"
  exit 1
fi
rm -f "$tmp_known"

# What ssh will ACTUALLY use, as ssh resolves it, rather than what we think we wrote. Keep this:
# it is the difference between diagnosing the problem above from one log line and diagnosing it
# by reproducing the image locally. Every value here should be ours, not a default.
echo "==> ssh setup: HOME=$HOME, $(wc -l < "$HOME/.ssh/known_hosts" | tr -d ' ') host keys pinned"
ssh -F "$HOME/.ssh/config" -G github.com 2>/dev/null \
  | grep -iE '^(userknownhostsfile|stricthostkeychecking|identityfile|user) ' \
  | sed 's/^/    /'

# Clone if missing, otherwise force the checkout to origin's tip on the given branch. Local
# commits and local modifications are DISCARDED, and what was discarded is logged. Callers that
# have files to preserve must save them before calling and restore them afterward.
clone_or_reset() {
  local url="$1" dir="$2" branch="$3"
  if [ ! -d "$dir/.git" ]; then
    echo "==> cloning $url -> $dir"
    git clone --branch "$branch" "$url" "$dir"
    return
  fi

  echo "==> resetting $dir to origin/$branch"
  git -C "$dir" fetch --quiet origin "$branch"

  # Log before discarding. A local commit here is the interesting case: it means either an agent
  # tried to change its own instructions outside a PR, or unpushed work was lost on a restart.
  local ahead dirty
  ahead=$(git -C "$dir" log --oneline FETCH_HEAD..HEAD 2>/dev/null || true)
  dirty=$(git -C "$dir" status --porcelain 2>/dev/null || true)
  if [ -n "$ahead" ]; then
    echo "WARNING: discarding local commits in $dir not present on origin/$branch:" >&2
    echo "$ahead" >&2
  fi
  if [ -n "$dirty" ]; then
    echo "==> discarding local modifications in $dir:"
    echo "$dirty"
  fi

  # -B so this also moves off a feature branch. Her instructions say to push a branch and return
  # to the default one; anything unpushed is gone here, which is the intended trade.
  git -C "$dir" checkout --force -B "$branch" FETCH_HEAD
  # -x as well as -fd: without it, gitignored files survive the reset. That would reopen the
  # hole this reset closes, since an agent-written skills/ file under any ignored path would
  # then be durable across restarts, absent from `git status`, and never pushed by the sync.
  # Safe here because the memory files live at $memory_live, outside this tree; what this does
  # destroy is the symlinks pointing at them, which the caller re-plants immediately afterwards.
  git -C "$dir" clean -ffdx
}

clone_or_reset git@github.com:olyapop/dotfiles.git "$HOME/dotfiles" main
"$HOME/dotfiles/script/setup"

# Memory paths, relative to both the repo root and $memory_live. Must match MEMORY_PATHS in
# memory-sync.mts.
memory_paths=(MEMORY.md DREAMS.md USER.md IDENTITY.md memory)

# ONE-TIME MIGRATION, idempotent. These used to live inside the checkout and survive the reset by
# being copied aside and put back. They now live at $memory_live, so the live copies have to be
# lifted out before the reset destroys them -- but only on the first boot after that change.
#
# The -L test is what makes this a no-op afterwards: once migrated, the workspace-root entry is a
# symlink into $memory_live rather than a real file, so there is nothing left to migrate. Copy
# rather than move, so a failure part-way leaves the originals in place for the next attempt.
if [ -d "$workspace/.git" ]; then
  for p in "${memory_paths[@]}"; do
    if [ -e "$workspace/$p" ] && [ ! -L "$workspace/$p" ] && [ ! -e "$memory_live/$p" ]; then
      echo "==> migrating memory path $p out of the workspace into $memory_live"
      cp -a "$workspace/$p" "$memory_live/$p"
    fi
  done
fi

clone_or_reset git@github.com:activescott/activeassistant.git "$workspace" main

# Cold start on an empty volume: nothing has been migrated and memory-core has not run yet, so
# seed from what the checkout carries. Without this the symlinks below would dangle, and while a
# write through a dangling symlink does create the target, a READ of one fails -- so the bootstrap
# files OpenClaw expects at workspace root would come back as missing on the very first turn.
for p in "${memory_paths[@]}"; do
  if [ ! -e "$memory_live/$p" ] && [ -e "$workspace/$p" ]; then
    echo "==> seeding memory path $p from the checkout"
    cp -a "$workspace/$p" "$memory_live/$p"
  fi
done
mkdir -p "$memory_live/memory"

# Replace the git-tracked copies at workspace root with symlinks into $memory_live.
#
# This is what keeps memory writable while the workspace around it is not. The olya container
# mounts $workspace read-only, so she cannot unlink or replace these links; but a write THROUGH
# one resolves to the absolute path $memory_live/..., which is reached via the read-write /state
# mount, and succeeds. OpenClaw reads IDENTITY.md and USER.md from workspace root, so they have to
# be here and not merely somewhere writable.
#
# `git status` will report these as local modifications on every subsequent boot, since the paths
# are tracked in the repo as regular files. That is cosmetic; clone_or_reset discards them and
# this puts them straight back.
for p in "${memory_paths[@]}"; do
  rm -rf "${workspace:?}/$p"
  ln -sfn "$memory_live/$p" "$workspace/$p"
done
echo "==> linked ${#memory_paths[@]} memory path(s) at workspace root -> $memory_live"

# Claude Code's auto-memory writes to a computed path based on the project directory
# ($HOME/.claude/projects/-state-workspace/memory), while MEMORY.md references memory/ relative to
# the workspace and the sync cronjob commits from there. Point it at the real directory rather
# than at the workspace symlink, so there is only one level of indirection to reason about.
mkdir -p "$HOME/.claude/projects/-state-workspace"
cc_mem="$HOME/.claude/projects/-state-workspace/memory"
if [ -d "$cc_mem" ] && [ ! -L "$cc_mem" ]; then
  cp -n "$cc_mem"/* "$memory_live/memory/" 2>/dev/null || true
  rm -rf "$cc_mem"
fi
ln -sfn "$memory_live/memory" "$cc_mem"
echo "==> linked Claude Code memory dir -> $memory_live/memory"

# Config seeding. The source of truth is the workspace repo rather than a ConfigMap, so this can
# only happen after the clone. install-plugins runs after this initContainer and needs the config
# in place.
#
# $config_live is its own directory, NOT $state/openclaw, because the olya container mounts it
# read-only and the OpenClaw state dir has to stay writable for the SQLite databases.
#
# `cp` overwrites in place and keeps the inode, which the gateway's inotify watch on this file
# depends on. Do not replace this with an unlink-and-recreate or with a symlink to the workspace
# copy: instruction-sync's `git checkout --force` swaps that file's inode, and the watch would
# silently follow the old one and stop noticing config changes.
cfg_src="$workspace/openclaw.json"
cfg_dst="$config_live/openclaw.json"
if [ -f "$cfg_src" ]; then
  cp "$cfg_src" "$cfg_dst"
  echo "==> seeded openclaw.json from workspace to $cfg_dst"
else
  echo "FATAL: $cfg_src not found after clone" >&2
  exit 1
fi

# The coding harnesses read their own instruction files from their own config paths, so the
# shared rules have to be copied into place rather than referenced. Copies, not symlinks:
# OpenClaw's skill loader enforces symlink containment and the harnesses are inconsistent about
# following them.
#
# The source is the working tree, which is safe only because the reset above just made it equal
# to origin's tip. It was not safe when this fast-forwarded and warned on divergence: a locally
# edited subagents/*/AGENTS.md was then reinstalled on every boot, indefinitely.
mkdir -p "$HOME/.config/opencode" "$HOME/.claude"
[ -f "$workspace/subagents/opencode/AGENTS.md" ] && \
  install -m 644 "$workspace/subagents/opencode/AGENTS.md" "$HOME/.config/opencode/AGENTS.md"
[ -f "$workspace/subagents/claude/CLAUDE.md" ] && \
  install -m 644 "$workspace/subagents/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"

# Repos are NOT pre-cloned. Work repos are cloned into $state/repos on demand and the checkout
# persists on the volume. A declared list here would drift, and would clone repositories nothing
# is touching on every cold start.
mkdir -p "$state/repos"

echo "==> seed-workspace complete"

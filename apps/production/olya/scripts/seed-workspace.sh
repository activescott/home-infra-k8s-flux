#!/usr/bin/env bash
# Runs as an initContainer on every pod start. Idempotent.
#
# Prepares the credential and workspace half of the volume.
#
# The workspace holds two kinds of file and they get opposite treatment:
#
#   Instruction files (everything except MEMORY_PATHS below) are DECLARATIVE. They are forced
#   back to origin's tip on every boot, discarding local commits and local edits. They only
#   change through a reviewed PR, and this is what makes that true of the files she actually
#   runs on rather than only of the branch in GitHub. Without it, an agent-written
#   skills/<name>/SKILL.md loads live and forever, is never committed by the sync job, and so is
#   invisible in both git and review.
#
#   Memory files are NOT declarative and survive. memory-core writes them continuously
#   (memory-flush before every compaction, a nightly dreaming sweep, observed-preference
#   directives appended to USER.md) and the hourly sync job is what gets them into git. They are
#   copied aside, the reset happens, and they are put back, so they persist as uncommitted
#   working-tree files until the next sync picks them up.
set -euo pipefail

state=/state
export HOME="$state/home"
workspace="$state/workspace"
ssh_key=/etc/olya-ssh/id_ed25519

mkdir -p "$HOME" "$state/openclaw" "$state/archive" "$state/repos"

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
  # Safe here because the memory paths are copied aside by the caller before this runs.
  git -C "$dir" clean -ffdx
}

clone_or_reset git@github.com:olyapop/dotfiles.git "$HOME/dotfiles" main
"$HOME/dotfiles/script/setup"

# Memory files, preserved across the reset. Must match MEMORY_PATHS in memory-sync.mts.
memory_paths=(MEMORY.md DREAMS.md USER.md IDENTITY.md memory)

saved=$(mktemp -d)
if [ -d "$workspace/.git" ]; then
  for p in "${memory_paths[@]}"; do
    [ -e "$workspace/$p" ] && cp -a "$workspace/$p" "$saved/"
  done
fi

echo "==> saved ${#memory_paths[@]} memory path(s) before reset (will restore after)"

clone_or_reset git@github.com:activescott/activeassistant.git "$workspace" main

for p in "${memory_paths[@]}"; do
  if [ -e "$saved/$p" ]; then
    rm -rf "$workspace/$p"
    cp -a "$saved/$p" "$workspace/$p"
  fi
done
rm -rf "$saved"
restored=()
for p in "${memory_paths[@]}"; do
  [ -e "$workspace/$p" ] && restored+=("$p")
done
if [ ${#restored[@]} -gt 0 ]; then
  echo "==> restored memory: ${restored[*]}"
fi

# Config seeding. Moved from the former seed-config initContainer: the source of truth
# is now this workspace repo rather than the ConfigMap, so it can only happen after the
# clone. install-plugins runs after this initContainer and needs the config in place.
cfg_src="$workspace/openclaw.json"
cfg_dst="$state/openclaw/openclaw.json"
if [ -f "$cfg_src" ]; then
  cp "$cfg_src" "$cfg_dst"
  echo "==> seeded openclaw.json from workspace"
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

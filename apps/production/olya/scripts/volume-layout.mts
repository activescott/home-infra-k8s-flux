// The layout of the assistant's volume, and the operations that maintain it.
//
// Three scripts touch this volume and they used to carry the same path list three times behind
// a "must match" comment: seed-workspace.mts (initContainer, every boot), instruction-sync.mts
// (sidecar, every 15 minutes) and memory-sync.mts (CronJob, hourly, in its own pod). A comment
// is not a mechanism, and the failure it invites is quiet: add a memory file, forget one of the
// three lists, and that file is either discarded on the next boot or never reaches git.
//
// All three mount the same olya-scripts ConfigMap at /scripts, so this module is importable
// from each of them.
//
// TypeScript run through Node's native type stripping. No build step and no transpiler; the
// image ships Node 24.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"

export const STATE = "/state"

/** $HOME. Her credential set, the dotfiles checkout, and the harnesses' own config trees. */
export const HOME_DIR = join(STATE, "home")

/** The activeassistant checkout. Mounted READ-ONLY in the olya container. */
export const WORKSPACE = join(STATE, "workspace")

/**
 * The live gateway config. Its own directory rather than a file inside $OPENCLAW_STATE_DIR,
 * because the olya container mounts this READ-ONLY and the state dir has to stay writable for
 * the SQLite databases.
 */
export const CONFIG_LIVE = join(STATE, "config")
export const CONFIG_FILE = join(CONFIG_LIVE, "openclaw.json")

/**
 * The memory files. Writable, and outside the checkout so a reset cannot touch them.
 *
 * Paths inside are REPO-RELATIVE, which is why the repo's own memory/ directory ends up at
 * /state/memory/memory. Awkward to read, and deliberate: memory-sync.mts copies these paths
 * straight into a fresh clone, so any rewriting here would have to be undone there.
 */
export const MEMORY_LIVE = join(STATE, "memory")

/**
 * Image staging for OpenClaw's claude-cli backend, which builds its path as
 * `path.join(workspaceDir, ".openclaw-cli-images")`. imagePathScope is hardcoded to "workspace"
 * in the backend definition and has no key in `openclaw config schema`, so unlike acpx's session
 * store this one cannot be pointed elsewhere by configuration.
 */
export const CLI_IMAGES_LIVE = join(STATE, "openclaw", "cli-images")

/**
 * The memory paths, relative to both the repo root and MEMORY_LIVE. THE list: every script that
 * needs it imports it from here.
 *
 * Adding one is a three-place change and the places are in two repositories. The path must be
 * tracked in activeassistant (the checkout is what provides the mountpoint), it must be here
 * (so it gets seeded), and it must have a matching volumeMount on the olya container in
 * olya-statefulset.yaml (so it is writable at runtime). Miss the mount and the gateway reads the
 * read-only checkout copy while the hourly sync pushes an untouched file, with nothing to see;
 * check-memory-mounts.mts exists to turn that into a loud failure.
 */
export const MEMORY_PATHS = ["MEMORY.md", "DREAMS.md", "USER.md", "IDENTITY.md", "memory"]

/**
 * The skills the coding harnesses need, canonical copy in the checkout. One directory per skill,
 * each holding a SKILL.md, which is the layout both harnesses search for.
 *
 * Her own skills stay at <workspace>/skills, where only OpenClaw's skill loader reads them.
 */
export const SHARED_SKILLS = join(WORKSPACE, ".agents", "skills")

/**
 * The global git hooks directory, pointed at by core.hooksPath. On the volume rather than in the
 * image because it has to exist in the olya container, whose root filesystem is read-only.
 */
export const GIT_HOOKS_DIR = join(HOME_DIR, ".githooks")

/**
 * Git's OTHER global config file, and the one this writes.
 *
 * `git config --global` would be the obvious call and is wrong here: it writes ~/.gitconfig,
 * which olyapop/dotfiles' script/setup symlinks into the dotfiles checkout, and git FOLLOWS that
 * symlink when it writes. The setting would land in the checkout, seed-workspace would discard
 * it on the next boot ("discarding local modifications"), and this would re-add it -- forever.
 *
 * Git reads both this file and ~/.gitconfig at global scope, so writing here sets the value
 * globally and leaves the dotfiles checkout alone. It is the lower-precedence of the two, which
 * costs nothing while nothing sets core.hooksPath in the dotfiles .gitconfig. XDG_CONFIG_HOME
 * would move it; the StatefulSet sets only HOME, in every container.
 */
const GIT_GLOBAL_CONFIG = join(HOME_DIR, ".config", "git", "config")

/**
 * The entries in MEMORY_PATHS that are directories rather than regular files. Exported because
 * check-memory-mounts.mts asserts the type at runtime, and a file where a directory belongs (or
 * the reverse) is how a kubelet-created subPath directory shows up.
 */
export const MEMORY_DIRECTORIES = new Set(["memory"])

/**
 * The memory paths that are files rather than directories. Updating the checkout must never
 * replace these inodes: each one is a bind-mount destination in the olya container, and when
 * git replaces a tracked file (unlink + new file) Linux detaches mounts on that path in every
 * other mount namespace. The sidecar pulling a memory-sync commit that way silently removed
 * Olya's MEMORY.md mount (activescott/activeassistant#109). The `memory` directory itself is
 * not listed: renames inside a bind-mounted directory stay visible, so its contents update
 * normally.
 */
export const MEMORY_FILES = MEMORY_PATHS.filter((path) => !MEMORY_DIRECTORIES.has(path))

function gitCheckout(args: string[], dir: string): string {
  return execFileSync("git", args, { cwd: dir, env: process.env, encoding: "utf8" }).trim()
}

/** The MEMORY_FILES entries actually tracked in the checkout at dir. */
function trackedMemoryFiles(dir: string): string[] {
  const tracked = new Set(gitCheckout(["ls-files"], dir).split("\n").map((line) => line.trim()))
  return MEMORY_FILES.filter((path) => tracked.has(path))
}

/**
 * Moves the checkout to origin's tip without replacing the memory files.
 *
 * A plain `git checkout --force` / `git reset --hard` rewrites every changed tracked file by
 * unlinking it, which detaches the olya container's bind mounts on the memory paths (see
 * MEMORY_FILES). `git update-index --skip-worktree` alone does not prevent that: the flag
 * hides the worktree divergence from status but checkout still replaces the file.
 *
 * So this updates everything EXCEPT the memory files (pathspec exclusion), deletes paths the
 * upstream removed, moves the branch ref without touching the worktree, and then points the
 * index entries for the memory files at the new blobs (also without touching the worktree)
 * so `git status` stays clean. The skip-worktree flag hides the resulting worktree divergence.
 */
export function syncCheckoutToOrigin(dir: string, branch: string): void {
  gitCheckout(["fetch", "--quiet", "origin", branch], dir)

  const head = gitCheckout(["rev-parse", "HEAD"], dir)
  const origin = gitCheckout(["rev-parse", `origin/${branch}`], dir)

  // -B semantics: also moves off a feature branch. Done via ref moves rather than checkout so
  // the memory files are never rewritten, including on this path.
  gitCheckout(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir)
  gitCheckout(["update-ref", `refs/heads/${branch}`, `origin/${branch}`], dir)
  if (head === origin) return

  const exclude = trackedMemoryFiles(dir).map((path) => `:!${path}`)
  const diffFiltered = (filter: string): string[] =>
    gitCheckout(
      ["diff", "--name-only", `--diff-filter=${filter}`, head, `origin/${branch}`, "--", ".", ...exclude],
      dir,
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

  // Updated or added paths, by explicit name: an exclude-only pathspec errors when the target
  // tree holds nothing it matches (e.g. upstream only deleted a file and changed memory).
  const changed = diffFiltered("ACMRTUXB")
  if (changed.length > 0) {
    gitCheckout(["checkout", "--quiet", `origin/${branch}`, "--", ...changed], dir)
  }
  // Paths upstream deleted. The checkout above may already have staged a removal; delete only
  // what still resolves, matching the discard-local-edits contract of the reset this replaces.
  for (const path of diffFiltered("D")) {
    if (gitCheckout(["ls-files", "--", path], dir) !== "") {
      gitCheckout(["rm", "--quiet", "--force", "--", path], dir)
    }
  }
  gitCheckout(["clean", "-ffdx"], dir)

  for (const path of trackedMemoryFiles(dir)) {
    const entry = gitCheckout(["ls-tree", `origin/${branch}`, "--", path], dir)
    if (!entry) {
      // Upstream deleted a mountpoint. The worktree copy stays, so the mount still resolves;
      // the startup check and the next fetch will keep shouting until it is restored upstream.
      console.log(`==> WARNING: memory path ${path} is no longer tracked on origin/${branch}`)
      continue
    }
    // ls-tree line: "<mode> blob <sha>\t<path>".
    const parts = entry.split(/\s+/)
    gitCheckout(["update-index", "--cacheinfo", `${parts[0]},${parts[2]},${path}`], dir)
  }
  const existing = trackedMemoryFiles(dir)
  if (existing.length > 0) {
    gitCheckout(["update-index", "--skip-worktree", "--", ...existing], dir)
  }
}

/**
 * Marks the memory files skip-worktree in a checkout. Idempotent; run after every clone, and
 * syncCheckoutToOrigin re-applies it after each update. This only hides the worktree
 * divergence the sync above deliberately keeps -- the exclusion in syncCheckoutToOrigin is
 * what actually protects the inodes.
 */
export function markMemorySkipWorktree(dir: string): void {
  const existing = trackedMemoryFiles(dir)
  if (existing.length > 0) {
    gitCheckout(["update-index", "--skip-worktree", "--", ...existing], dir)
  }
}

/**
 * Makes every bind-mount source exist before the olya container starts, and proves it afterwards.
 *
 * Both halves matter. kubelet creates a DIRECTORY for a subPath source that does not exist, owned
 * by root, and fsGroup does not correct that on a hostPath volume -- so a missing file here does
 * not fail cleanly, it produces a root-owned directory that persists on the volume and that
 * OpenClaw later rejects with "Refusing to write non-file DREAMS.md". Creating the sources in
 * this initContainer is what stops that, and it works because kubelet resolves a container's
 * subPaths when that container is created, i.e. after initContainers have finished.
 *
 * Seeding prefers the checkout: on a cold volume the tracked copies are the starting content.
 * An empty file is the fallback for a path the repo does not carry yet, which is a valid state
 * only because the file is about to be shadowed by the mount anyway.
 */
export function seedMemoryFromCheckout(): void {
  mkdirSync(MEMORY_LIVE, { recursive: true })
  mkdirSync(CLI_IMAGES_LIVE, { recursive: true })

  for (const path of MEMORY_PATHS) {
    const live = join(MEMORY_LIVE, path)
    if (existsSync(live)) continue

    const fromCheckout = join(WORKSPACE, path)
    if (existsSync(fromCheckout)) {
      console.log(`==> seeding memory path ${path} from the checkout`)
      cpSync(fromCheckout, live, { recursive: true })
    } else if (MEMORY_DIRECTORIES.has(path)) {
      console.log(`==> creating empty memory directory ${path}`)
      mkdirSync(live, { recursive: true })
    } else {
      console.log(`==> creating empty memory file ${path}`)
      mkdirSync(dirname(live), { recursive: true })
      writeFileSync(live, "")
    }
  }

  // Assert the TYPE, not just existence. This is the half that catches a root-owned directory
  // kubelet created on a previous boot, which would otherwise sit there breaking memory writes
  // with no other symptom.
  for (const path of MEMORY_PATHS) {
    const live = join(MEMORY_LIVE, path)
    const wantDirectory = MEMORY_DIRECTORIES.has(path)
    const stats = lstatSync(live)
    const isRight = wantDirectory ? stats.isDirectory() : stats.isFile()
    if (!isRight) {
      throw new Error(
        `${live} is not a ${wantDirectory ? "directory" : "regular file"}. ` +
          `kubelet creates a directory for a subPath source that does not exist; remove it by ` +
          `hand and restart so this can recreate it correctly.`,
      )
    }
  }

  console.log(`==> memory sources ready under ${MEMORY_LIVE} (${MEMORY_PATHS.length} path(s))`)
}

/**
 * Publishes the checkout's openclaw.json to where the gateway actually reads it.
 *
 * copyFileSync overwrites IN PLACE and keeps the inode, which the gateway's inotify watch on
 * this file depends on. Do not change this to unlink-and-recreate, and do not point the gateway
 * at the workspace copy instead: `git checkout --force` swaps that file's inode, so the watch
 * would silently follow the old one and stop noticing config changes.
 */
export function publishConfig(): void {
  const source = join(WORKSPACE, "openclaw.json")
  if (!existsSync(source)) {
    throw new Error(`${source} not found in the checkout`)
  }
  mkdirSync(CONFIG_LIVE, { recursive: true })
  copyFileSync(source, CONFIG_FILE)
  console.log(`==> published openclaw.json from the checkout to ${CONFIG_FILE}`)
}

/**
 * Installs the shared subagent instructions where each coding harness looks for them, then links
 * the shared skills the instructions refer to.
 *
 * The harnesses read their own instruction files from their own config paths, so these have to
 * be copied into place rather than referenced. Copies, not symlinks: OpenClaw's skill loader
 * enforces symlink containment and the harnesses are inconsistent about following them. The same
 * policy is why the memory paths are bind mounts rather than symlinks; see
 * docs/specs/olya-readonly-instructions/plan-memory-bind-mounts.md. The skills are the exception
 * and linkSharedSkills says why.
 *
 * The source is the working tree, which is safe only because the caller has just reset it to
 * origin's tip. It was not safe when the sync fast-forwarded and warned on divergence: a locally
 * edited subagents/*\/AGENTS.md was then reinstalled on every boot, indefinitely.
 */
export function installSubagentFiles(): void {
  const installs = [
    {
      source: join(WORKSPACE, "subagents", "opencode", "AGENTS.md"),
      target: join(HOME_DIR, ".config", "opencode", "AGENTS.md"),
    },
    {
      source: join(WORKSPACE, "subagents", "claude", "CLAUDE.md"),
      target: join(HOME_DIR, ".claude", "CLAUDE.md"),
    },
  ]
  for (const { source, target } of installs) {
    if (!existsSync(source) || !lstatSync(source).isFile()) continue
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }

  linkSharedSkills(SHARED_SKILLS, HOME_DIR)
}

/**
 * Points a harness skill path at the checkout. Idempotent, which matters because the sidecar
 * runs this every 15 minutes: a link that already points at the source is left as it is.
 *
 * A link pointing somewhere else is replaced. Anything that is NOT a symlink is left alone and
 * logged, because removing it to make room would delete whatever owns it.
 */
function linkSkillPath(source: string, target: string): void {
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(target) === source) return
    rmSync(target)
  } else if (existing) {
    console.log(`==> WARNING: ${target} is not a symlink; leaving it alone`)
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target)
  console.log(`==> linked ${target} -> ${source}`)
}

/**
 * Links the shared skills into the skill directories the coding harnesses search.
 *
 * The instruction files above are COPIED out of the checkout, so a repo-relative link written
 * inside one resolves to nothing at the destination. That is not hypothetical: both files told
 * every coding agent to read `../../shared/writing-style.md`, which exists relative to the source
 * and nowhere near `~/.claude/CLAUDE.md`, so no coding agent ever read it
 * (activescott/activeassistant#122). The skills are reached through a link at a fixed absolute
 * path instead.
 *
 * Symlinks rather than copies, unlike the instruction files: there is then one file to edit, and
 * $HOME is writable while nothing in either harness path-checks these locations. A link into
 * WORKSPACE resolves from the olya container even though that mount is read-only there.
 *
 * The two halves are not symmetrical, and that is the point:
 *
 *   ~/.agents/skills is one of the six locations opencode searches, and nothing else writes it,
 *   so it is a single link for the whole tree.
 *
 *   ~/.claude/skills is NOT ours alone. The Anthropic-managed skills arrive under synced/ and a
 *   whole-directory link would detach them, so this links one entry per skill beside it.
 */
export function linkSharedSkills(skillsDir: string, homeDir: string): void {
  if (!existsSync(skillsDir)) {
    console.log(`==> no shared skills at ${skillsDir}; nothing to link`)
    return
  }

  linkSkillPath(skillsDir, join(homeDir, ".agents", "skills"))

  const claudeSkills = join(homeDir, ".claude", "skills")
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    linkSkillPath(join(skillsDir, entry.name), join(claudeSkills, entry.name))
  }

  // A skill renamed or removed upstream leaves a dangling link behind, which the harness then
  // scans and cannot read. Only links whose target is inside skillsDir are considered, so
  // synced/ and anything else in that directory is untouchable here.
  if (!existsSync(claudeSkills)) return
  for (const entry of readdirSync(claudeSkills, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const link = join(claudeSkills, entry.name)
    const target = readlinkSync(link)
    if (target.startsWith(`${skillsDir}/`) && !existsSync(target)) {
      console.log(`==> removing stale skill link ${link} -> ${target}`)
      rmSync(link)
    }
  }
}

/**
 * The commit-msg hook. POSIX sh rather than Node: it runs in whatever repository someone is
 * committing in, and `sh`, `awk` and `grep` are the things that are certainly there.
 *
 * Two details in it are not decoration, and removing either breaks something.
 *
 * It reads only the text git will actually STORE. `git commit -v` appends the full diff below
 * the scissors line, so a hook that scanned the raw file would reject any commit whose diff
 * mentions one of these patterns -- including, circularly, this file.
 *
 * It chains to the repository's own .git/hooks/commit-msg. core.hooksPath REPLACES that lookup
 * rather than adding to it, so switching this on would otherwise silently stop running a hook
 * some repository ships. Nothing on this volume has one today; the chain keeps that from
 * becoming a trap later.
 */
const COMMIT_MSG_HOOK = `#!/bin/sh
# Rejects AI attribution trailers. Installed by apps/production/olya/scripts/volume-layout.mts
# in activescott/home-infra-k8s-flux; edit it there, not here -- this copy is rewritten on every
# pod start.
#
# This exists because the instruction did not hold. subagents/claude/CLAUDE.md prohibits the
# Co-Authored-By trailer by name, explains that the harness template pulls toward adding it, and
# says to check the finished text before sending; an agent read that file and pushed the trailer
# anyway (activescott/activeassistant#124, and #44 before it for the "Generated with" footer).
# The read-only workspace mount is the pattern that worked: make the failure mechanical.
#
# It applies to everyone committing on this volume, deliberately. The same template pressure
# applies to hand-written messages, and an exception for one author is an exception.
set -u

[ "$#" -ge 1 ] || exit 0
msg_file=$1
[ -f "$msg_file" ] || exit 0

cc=$(git config --get core.commentChar 2>/dev/null)
[ -n "$cc" ] && [ "$cc" != auto ] || cc='#'

# The subject and body only. Comment lines are blanked rather than dropped so the line numbers
# below still refer to the real file, and everything from the scissors line down is the -v diff.
clean=$(awk -v cc="$cc" '
  substr($0, 1, length(cc)) == cc && index($0, ">8") { exit }
  substr($0, 1, length(cc)) == cc { print ""; next }
  { print }
' "$msg_file")

matched=0
for pattern in \\
  'Co-Authored-By:.*(Claude|Anthropic|noreply@anthropic)' \\
  'Generated with' \\
  'Claude-Session:' \\
  'claude\\.ai/code'
do
  hits=$(printf '%s\\n' "$clean" | grep -n -i -E -- "$pattern") || continue
  if [ "$matched" -eq 0 ]; then
    echo "commit-msg: rejected. This message carries AI attribution." >&2
    matched=1
  fi
  echo >&2
  echo "  pattern: $pattern" >&2
  printf '%s\\n' "$hits" | sed 's/^\\([0-9][0-9]*\\):/  line \\1: /' >&2
done

if [ "$matched" -ne 0 ]; then
  echo >&2
  echo "  Delete the line(s) above and commit again." >&2
  exit 1
fi

# Whatever the repository itself wanted to run, which core.hooksPath just displaced.
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -x "$common/hooks/commit-msg" ] || exit 0
exec "$common/hooks/commit-msg" "$@"
`

/**
 * Installs the commit-msg hook and points git at it globally. Idempotent: the write overwrites
 * with identical content and the config set is the same value every time.
 *
 * Global rather than per-repo because agents create clones and worktrees constantly and anything
 * needing a setup step would be missed by exactly the clone that needed it.
 *
 * Global config does NOT reach a repository that sets core.hooksPath locally, which husky does
 * (`core.hooksPath = .husky/_`, written by its `prepare` script on npm install). Repos on this
 * volume using husky -- fernfiles, tinkerbell, gpu-agent -- are not covered by this and need the
 * check in their own .husky/commit-msg.
 *
 * The roots are parameters, like linkSharedSkills above, so this can be exercised against a
 * throwaway directory without writing the assistant's live git config.
 */
export function installGitHooks(hooksDir = GIT_HOOKS_DIR, configFile = GIT_GLOBAL_CONFIG): void {
  mkdirSync(hooksDir, { recursive: true })
  const hook = join(hooksDir, "commit-msg")
  writeFileSync(hook, COMMIT_MSG_HOOK)
  // Written then chmod'ed: the mode argument applies only when the file is created, and this
  // file already exists on every boot after the first.
  chmodSync(hook, 0o755)

  mkdirSync(dirname(configFile), { recursive: true })
  execFileSync("git", ["config", "--file", configFile, "core.hooksPath", hooksDir], {
    env: process.env,
    encoding: "utf8",
  })
  console.log(`==> commit-msg hook at ${hook}; core.hooksPath -> ${hooksDir}`)
}

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
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
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
 * The memory paths, relative to both the repo root and MEMORY_LIVE. THE list: every script that
 * needs it imports it from here.
 *
 * Adding one is not just a matter of appending. A new memory path is a file the boot reset must
 * not discard and the hourly sync must push, so check it is covered by both.
 */
export const MEMORY_PATHS = ["MEMORY.md", "DREAMS.md", "USER.md", "IDENTITY.md", "memory"]

/**
 * Paths inside the read-only workspace that third-party code insists on writing to, redirected
 * by symlink to somewhere writable.
 *
 * Most of these are configurable and should be configured instead -- acpx's session store was,
 * via plugins.entries.acpx.config.stateDir in openclaw.json. This list is for the ones that are
 * not: a hardcoded path in code we do not own, where the only alternatives are redirecting it or
 * accepting that the feature is broken.
 *
 * A symlink and NOT an emptyDir mounted over the path. A mount point inside the checkout cannot
 * be removed by `git clean -ffdx`, so the reset would fail with EBUSY and crashloop
 * seed-workspace on every boot. The symlink also keeps the escape hatch declared in one
 * reviewable list rather than buried in the StatefulSet's volume section.
 *
 * Adding an entry widens what she can write, so it needs a reason that names the code doing the
 * writing. The target must be writable in the olya container and must not be inside WORKSPACE.
 */
export const WORKSPACE_ESCAPE_HATCHES = [
  {
    // openclaw's claude-cli backend: `if (backend.imagePathScope === "workspace") return
    // path.join(workspaceDir, ".openclaw-cli-images")`. imagePathScope is hardcoded to
    // "workspace" in the backend definition, with no config key anywhere in `openclaw config
    // schema`, so it cannot be pointed elsewhere. claude-cli is the default runtime for
    // anthropic/* models, which means without this every image sent to her fails to stage.
    link: ".openclaw-cli-images",
    target: join(STATE, "openclaw", "cli-images"),
  },
]

/**
 * True for a `git status --porcelain` path that this pod's own symlinks are expected to dirty.
 *
 * Every boot leaves the workspace dirty in exactly one way, because the memory paths are tracked
 * in the repo as regular files and this pod replaces them with symlinks into MEMORY_LIVE. git
 * reports that as a typechange on the four top-level files, and — because `memory` became a
 * symlink rather than a directory — as a DELETION of all 22 tracked files underneath it:
 *
 *      T IDENTITY.md
 *      T MEMORY.md
 *      T USER.md
 *      D memory/MEMORY.md
 *      D memory/feedback-board-ownership.md
 *      ... 20 more
 *
 * That is 28 lines per boot that read like memory files being deleted right before a reset,
 * which is precisely what the 2026-09-12 incident looked like. Logging it as "discarding local
 * modifications" trains the reader to skip the one message that is supposed to be alarming, so
 * callers use this to separate the churn from a real local edit and report the two differently.
 *
 * The escape-hatch links add one untracked entry each (`?? .openclaw-cli-images`) for the same
 * reason and are covered here too.
 *
 * Deliberately NOT a blanket suppression: an edit to any other path still gets logged loudly.
 */
export function isExpectedMemoryDirt(path: string): boolean {
  const ours = [...MEMORY_PATHS, ...WORKSPACE_ESCAPE_HATCHES.map(hatch => hatch.link)]
  return ours.some(ourPath => path === ourPath || path.startsWith(`${ourPath}/`))
}

/**
 * Splits `git status --porcelain` output into the paths the caller expects and everything else.
 *
 * Status codes are matched as one or two characters rather than at fixed columns, because the
 * caller's git helper trims its output and that removes the leading space of the first line only.
 * Anything the pattern does not recognise (a rename's `old -> new`, a path git chose to quote)
 * falls through to `unexpected` and gets logged loudly, which is the safe direction to fail.
 */
export function splitDirty(
  porcelain: string,
  isExpected: (path: string) => boolean,
): { expected: string[]; unexpected: string[] } {
  const expected: string[] = []
  const unexpected: string[] = []
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue
    const match = /^\s*([A-Z?!]{1,2})\s+(.+)$/.exec(line)
    if (match && isExpected(match[2])) expected.push(line)
    else unexpected.push(line)
  }
  return { expected, unexpected }
}

/**
 * Points the memory paths at workspace root back at MEMORY_LIVE, replacing whatever the checkout
 * put there. Called after every reset: at boot by seed-workspace.mts, and on every change by
 * instruction-sync.mts.
 *
 * This is what keeps memory writable while the workspace around it is not. The olya container
 * mounts WORKSPACE read-only, so she cannot unlink or replace these links; but a write THROUGH
 * one resolves to the absolute path under MEMORY_LIVE, which is reached via the read-write
 * /state mount, and succeeds. OpenClaw reads IDENTITY.md and USER.md from workspace root, so
 * they have to be here and not merely somewhere writable.
 *
 * A path missing from MEMORY_LIVE is seeded from the checkout first. That is the cold start on
 * an empty volume: a write through a dangling symlink would create the target, but a READ of one
 * fails, so the bootstrap files OpenClaw expects would come back missing on the very first turn.
 *
 * `git status` reports these as local modifications on every subsequent boot, since the paths are
 * tracked in the repo as regular files. That is cosmetic; the reset discards them and this puts
 * them straight back.
 */
export function linkMemoryIntoWorkspace(): void {
  for (const path of MEMORY_PATHS) {
    const live = join(MEMORY_LIVE, path)
    const link = join(WORKSPACE, path)
    if (!existsSync(live) && existsSync(link)) {
      console.log(`==> seeding memory path ${path} from the checkout`)
      cpSync(link, live, { recursive: true })
    }
    rmSync(link, { recursive: true, force: true })
    symlinkSync(live, link)
  }
  // AFTER the loop, never before: creating it first would make the "memory" entry look present
  // and skip seeding it from the checkout, so a cold start would come up with an empty memory
  // directory and no sign anything went wrong.
  mkdirSync(join(MEMORY_LIVE, "memory"), { recursive: true })
  console.log(`==> linked ${MEMORY_PATHS.length} memory path(s) at workspace root -> ${MEMORY_LIVE}`)
}

/**
 * Plants the WORKSPACE_ESCAPE_HATCHES symlinks. Called after every reset, alongside
 * linkMemoryIntoWorkspace, because `git clean -ffdx` removes them as untracked entries.
 *
 * The target directory is created first. mkdir(recursive) through a symlink whose target does not
 * exist does not create the target, so a dangling link here would fail the write it exists to
 * allow -- the opposite of the memory paths, where a dangling link is tolerable because the
 * writer creates the file.
 */
export function linkWritableEscapeHatches(): void {
  for (const { link, target } of WORKSPACE_ESCAPE_HATCHES) {
    mkdirSync(target, { recursive: true })
    const linkPath = join(WORKSPACE, link)
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(target, linkPath)
    console.log(`==> linked ${link} at workspace root -> ${target}`)
  }
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
 * Installs the shared subagent instructions where each coding harness looks for them.
 *
 * The harnesses read their own instruction files from their own config paths, so these have to
 * be copied into place rather than referenced. Copies, not symlinks: OpenClaw's skill loader
 * enforces symlink containment and the harnesses are inconsistent about following them.
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
}

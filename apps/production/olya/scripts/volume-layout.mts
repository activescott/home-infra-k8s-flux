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

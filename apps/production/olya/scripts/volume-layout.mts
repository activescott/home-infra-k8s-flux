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
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs"
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
 * The entries in MEMORY_PATHS that are directories rather than regular files. Exported because
 * check-memory-mounts.mts asserts the type at runtime, and a file where a directory belongs (or
 * the reverse) is how a kubelet-created subPath directory shows up.
 */
export const MEMORY_DIRECTORIES = new Set(["memory"])

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
 * Installs the shared subagent instructions where each coding harness looks for them.
 *
 * The harnesses read their own instruction files from their own config paths, so these have to
 * be copied into place rather than referenced. Copies, not symlinks: OpenClaw's skill loader
 * enforces symlink containment and the harnesses are inconsistent about following them. The same
 * policy is why the memory paths are bind mounts rather than symlinks; see
 * docs/specs/olya-readonly-instructions/plan-memory-bind-mounts.md.
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

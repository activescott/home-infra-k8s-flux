#!/usr/bin/env -S node --experimental-strip-types
// Runs as an initContainer on every pod start. Idempotent.
//
// Prepares the credential and workspace half of the volume.
//
// The volume holds two kinds of file and they get opposite treatment, which this script is what
// physically separates:
//
//   Instruction files (everything in the checkout except the memory paths) and the gateway
//   config are DECLARATIVE. They are forced back to origin's tip on every boot, discarding local
//   commits and local edits, and they land under WORKSPACE and CONFIG_LIVE -- the two paths the
//   olya container mounts READ-ONLY. They change only through a reviewed PR, and the mount is
//   what makes that true of the files she actually runs on rather than only of the branch in
//   GitHub. Before the read-only mounts existed, an agent-written skills/<name>/SKILL.md loaded
//   live and forever, was never committed by the sync job, and so was invisible in both git and
//   review; and on 2026-09-15 the live openclaw.json was hand-edited and crashed the gateway.
//
//   Memory files are NOT declarative. memory-core writes them continuously (memory-flush before
//   every compaction, a nightly dreaming sweep) and the hourly sync job is what gets them into git. They live at MEMORY_LIVE, which
//   stays writable, and reach workspace root as bind mounts declared on the olya container. This
//   script's job is to make sure every mount SOURCE exists before that container starts.
//
// TypeScript rather than bash so the path list and the post-reset sequence are imported
// from volume-layout.mts and shared with instruction-sync.mts, which performs the same sequence
// every 15 minutes. They used to be two copies kept in step by a comment.
import { execFileSync } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  CONFIG_LIVE,
  HOME_DIR,
  MEMORY_LIVE,
  MEMORY_PATHS,
  STATE,
  WORKSPACE,
  installGitHooks,
  installSubagentFiles,
  markMemorySkipWorktree,
  publishConfig,
  seedMemoryFromCheckout,
  syncCheckoutToOrigin,
} from "./volume-layout.mts"

const sshKey = "/etc/olya-ssh/id_ed25519"
const sshDir = join(HOME_DIR, ".ssh")
const sshConfig = join(sshDir, "config")
const knownHosts = join(sshDir, "known_hosts")

// Every ssh that reads the config below goes through the egress proxy, whatever started it
// (activescott/activeassistant#316). GIT_SSH_COMMAND in olya-statefulset.yaml carries the same
// ProxyCommand, but OpenClaw's claude-cli backend drops that one variable from the environment of
// the `claude` processes it starts, so git in their shells falls back to the dotfiles'
// core.sshCommand, `ssh -F` this file, and went direct (activescott/activeassistant#317). At the
// top because ssh keeps the first value it finds for each option.
const PROXY_STANZA = [
  "# Written by seed-workspace.mts: every host through the egress proxy.",
  "Host *",
  "  ProxyCommand /scripts/ssh-proxy-connect.mts %h %p",
  "",
].join("\n")

function withProxyCommand(config: string): string {
  return config.startsWith(PROXY_STANZA) ? config : `${PROXY_STANZA}\n${config}`
}

function log(msg: string): void {
  console.log(`==> ${msg}`)
}

function fatal(msg: string): never {
  console.error(`FATAL: ${msg}`)
  process.exit(1)
  // Unreachable. process.exit is typed as returning never only with @types/node, which this
  // repo deliberately does not install, so the throw is what makes the function total.
  throw new Error("unreachable")
}

for (const dir of [
  HOME_DIR,
  join(STATE, "openclaw"),
  join(STATE, "archive"),
  // Repos are NOT pre-cloned. Work repos are cloned into this directory on demand and the
  // checkout persists on the volume. A declared list would drift, and would clone repositories
  // nothing is touching on every cold start.
  join(STATE, "repos"),
  MEMORY_LIVE,
  CONFIG_LIVE,
]) {
  mkdirSync(dir, { recursive: true })
}

try {
  accessSync(sshKey, constants.R_OK)
} catch {
  fatal(`ssh key not readable at ${sshKey}`)
}

// ssh MUST be pointed at this config explicitly, and every path inside it must be absolute.
//
// OpenSSH does not use $HOME to find ~/.ssh. It reads the home directory out of the passwd
// entry, and uid 1000 in this image is `node`, whose passwd home is /home/node -- which is on
// the read-only root filesystem and holds nothing. So without -F, ssh silently ignores
// everything written below and fails with "Host key verification failed", which reads like a
// bad known_hosts rather than a config it never opened. Verified with `ssh -G`: user,
// StrictHostKeyChecking and UserKnownHostsFile all came back as built-in defaults.
//
// -F fixes which file is read. It does NOT fix `~` INSIDE that file: tilde expansion also uses
// the passwd entry, so `UserKnownHostsFile ~/.ssh/known_hosts` still resolves to /home/node.
// Hence the absolute paths written below, and in olyapop/dotfiles' ssh/config.
//
// Set in this process's environment because every git child below inherits it. The olya and
// instruction-sync containers get the same value from the StatefulSet; this initContainer does
// not, because the config it names does not exist until this script writes it.
process.env.HOME = HOME_DIR
process.env.GIT_SSH_COMMAND = `ssh -F ${sshConfig}`

// Minimal ssh config, enough to clone the private dotfiles repo. Her dotfiles' script/setup
// installs the real one immediately afterward; this exists only to break the circular dependency
// of "the config needed to clone the repo that provides the config".
mkdirSync(sshDir, { recursive: true })
chmodSync(sshDir, 0o700)
writeFileSync(
  sshConfig,
  [
    PROXY_STANZA,
    "Host github.com",
    "  User git",
    `  IdentityFile ${sshKey}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile ${knownHosts}`,
    "",
  ].join("\n"),
)
chmodSync(sshConfig, 0o600)

// Pin github.com's host keys from its published metadata rather than ssh-keyscan. ssh-keyscan
// trusts whatever answers on port 22, which is trust-on-first-use over an unauthenticated
// channel; api.github.com is authenticated by TLS.
let pinned = ""
try {
  const response = await fetch("https://api.github.com/meta", {
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const meta = await response.json()
  const keys = Array.isArray(meta?.ssh_keys) ? meta.ssh_keys : []
  pinned = keys.map((key: string) => `github.com ${key}\n`).join("")
} catch (err) {
  const e = err as { message?: string }
  console.error(`WARNING: could not read github.com host keys: ${e.message ?? err}`)
}

if (pinned) {
  // Written then chmod'ed: the mode argument only applies when the file is created, and this
  // file already exists on every boot after the first.
  writeFileSync(knownHosts, pinned)
  chmodSync(knownHosts, 0o600)
} else if (existsSync(knownHosts) && statSync(knownHosts).size > 0) {
  console.error("WARNING: could not reach api.github.com; keeping existing known_hosts")
} else {
  fatal("could not reach api.github.com and no known_hosts exists")
}

// What ssh will ACTUALLY use, as ssh resolves it, rather than what we think we wrote. Keep this:
// it is the difference between diagnosing the problem above from one log line and diagnosing it
// by reproducing the image locally. Every value here should be ours, not a default.
const hostKeyCount = readFileSync(knownHosts, "utf8").trimEnd().split("\n").length
log(`ssh setup: HOME=${HOME_DIR}, ${hostKeyCount} host keys pinned`)
try {
  const resolved = execFileSync("ssh", ["-F", sshConfig, "-G", "github.com"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  for (const line of resolved.split("\n")) {
    if (/^(userknownhostsfile|stricthostkeychecking|identityfile|user|proxycommand) /i.test(line)) {
      console.log(`    ${line}`)
    }
  }
} catch {
  console.error("WARNING: `ssh -G` failed; continuing")
}

function git(args: string[], opts: { cwd?: string; allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: opts.cwd,
      env: process.env,
      encoding: "utf8",
    }).trim()
  } catch (err) {
    if (opts.allowFail) return ""
    throw err
  }
}

// Clone if missing, otherwise force the checkout to origin's tip on the given branch. Local
// commits and local modifications are DISCARDED, and what was discarded is logged.
//
// When preserveMemory is set (the workspace checkout), the update never replaces the memory
// files: a plain checkout/reset unlinks changed tracked files, which detaches the olya
// container's bind mounts on those paths in its own mount namespace
// (activescott/activeassistant#109). See syncCheckoutToOrigin.
function cloneOrReset(url: string, dir: string, branch: string, preserveMemory = false): void {
  if (!existsSync(join(dir, ".git"))) {
    log(`cloning ${url} -> ${dir}`)
    execFileSync("git", ["clone", "--branch", branch, url, dir], {
      env: process.env,
      stdio: "inherit",
    })
    if (preserveMemory) markMemorySkipWorktree(dir)
    return
  }

  log(`resetting ${dir} to origin/${branch}`)
  git(["fetch", "--quiet", "origin", branch], { cwd: dir })

  // Log before discarding. A local commit here is the interesting case: it means either an agent
  // tried to change its own instructions outside a PR, or unpushed work was lost on a restart.
  const ahead = git(["log", "--oneline", "FETCH_HEAD..HEAD"], { cwd: dir, allowFail: true })
  const dirty = git(["status", "--porcelain"], { cwd: dir, allowFail: true })
  if (ahead) {
    console.error(`WARNING: discarding local commits in ${dir} not present on origin/${branch}:`)
    console.error(ahead)
  }
  // Every line here is worth reading. This pod no longer writes anything into the checkout --
  // the memory paths reach the olya container as bind mounts that do not exist in this mount
  // namespace -- so a dirty tree means something genuinely edited it.
  //
  // One exception, once: the first boot after the bind-mount change runs against a tree that
  // still holds the previous boot's symlinks, and logs ~28 typechange and deletion lines. It
  // looks like the 2026-09-12 incident and is not. Every boot after that is clean.
  if (dirty) {
    log(`discarding local modifications in ${dir}:`)
    console.log(dirty)
  }

  // -B so this also moves off a feature branch. Her instructions say to push a branch and return
  // to the default one; anything unpushed is gone here, which is the intended trade.
  if (preserveMemory) {
    // Safe for the memory paths because they live at MEMORY_LIVE, outside this tree. What sits
    // at workspace root here is the tracked checkout copy, which is also the mountpoint the
    // olya container binds over -- so leaving its inode alone preserves the mount.
    syncCheckoutToOrigin(dir, branch)
    return
  }
  git(["checkout", "--force", "-B", branch, "FETCH_HEAD"], { cwd: dir })
  // -x as well as -fd: without it, gitignored files survive the reset. That would reopen the
  // hole this reset closes, since an agent-written skills/ file under any ignored path would
  // then be durable across restarts, absent from `git status`, and never pushed by the sync.
  git(["clean", "-ffdx"], { cwd: dir })
}

cloneOrReset("git@github.com:olyapop/dotfiles.git", join(HOME_DIR, "dotfiles"), "main")
execFileSync(join(HOME_DIR, "dotfiles", "script", "setup"), [], {
  env: process.env,
  stdio: "inherit",
})
// The dotfiles setup has just replaced the config above with its own.
writeFileSync(sshConfig, withProxyCommand(readFileSync(sshConfig, "utf8")))
chmodSync(sshConfig, 0o600)

// Right after the dotfiles setup that installs the git identity and signing config, because this
// is the rest of that same configuration. It writes a different file on purpose; see
// GIT_GLOBAL_CONFIG.
installGitHooks()

// LEGACY VOLUME SAFETY NET, idempotent, and it has already done its job on the live volume.
//
// Memory used to live inside the checkout, where the reset below would destroy it. Restoring a
// snapshot from before 2026-09-16 would reproduce that state, so this lifts anything found at
// workspace root out to MEMORY_LIVE before the reset runs. seedMemoryFromCheckout does the same
// thing afterwards for a cold volume; this one runs first because only it sees local edits that
// were never committed.
//
// The MEMORY_LIVE check is what makes it a no-op on every normal boot.
if (existsSync(join(WORKSPACE, ".git"))) {
  for (const path of MEMORY_PATHS) {
    const source = join(WORKSPACE, path)
    if (!existsSync(join(MEMORY_LIVE, path)) && existsSync(source)) {
      log(`migrating memory path ${path} out of the workspace into ${MEMORY_LIVE}`)
      cpSync(source, join(MEMORY_LIVE, path), { recursive: true, dereference: false })
    }
  }
}

cloneOrReset("git@github.com:activescott/activeassistant.git", WORKSPACE, "main", true)

// Must happen here, in an initContainer, and not later: kubelet resolves the olya container's
// subPath mounts when that container is created, and creates a root-owned DIRECTORY for any
// source that does not exist yet.
seedMemoryFromCheckout()
publishConfig()
installSubagentFiles()

// Claude Code's auto-memory writes to a computed path based on the project directory
// ($HOME/.claude/projects/-state-workspace/memory), while MEMORY.md references memory/ relative
// to the workspace and the sync cronjob commits from there. Point it at MEMORY_LIVE directly
// rather than at the workspace path, so this does not depend on the bind mounts existing.
//
// A symlink is fine HERE, unlike at workspace root: $HOME is writable and nothing in OpenClaw
// path-checks this location. Claude Code resolves it and writes through to the real directory.
const claudeProject = join(HOME_DIR, ".claude", "projects", "-state-workspace")
const claudeMemory = join(claudeProject, "memory")
mkdirSync(claudeProject, { recursive: true })
// A real directory here is a pre-symlink pod that wrote memory into $HOME. Keep what it wrote:
// force: false so an existing file at the destination wins, matching `cp -n`.
if (existsSync(claudeMemory) && !lstatSync(claudeMemory).isSymbolicLink()) {
  cpSync(claudeMemory, join(MEMORY_LIVE, "memory"), { recursive: true, force: false })
}
rmSync(claudeMemory, { recursive: true, force: true })
symlinkSync(join(MEMORY_LIVE, "memory"), claudeMemory)
log(`linked Claude Code memory dir -> ${join(MEMORY_LIVE, "memory")}`)

log("seed-workspace complete")

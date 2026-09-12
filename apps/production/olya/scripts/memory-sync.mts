#!/usr/bin/env -S node --experimental-strip-types
// Commits and pushes Olya's memory files to git. Runs hourly as a CronJob.
//
// The memory files are treated as DATA, never as a repository. This job clones the remote into
// its own pod-local scratch dir, copies the memory files in, and commits there. It deliberately
// never runs git inside /state/workspace, which is mounted read-only here.
//
// That matters because /state/workspace/.git is writable by the agent's uid, and git treats a
// repository's own .git directory as trusted code: hooks (pre-commit, and reference-transaction
// which fires on fetch), plus core.hooksPath, credential.helper, core.sshCommand and
// url.<host>.insteadOf in .git/config. Running git there with a push credential available means
// the agent chooses what code executes in this pod. There is no git flag that makes .git/config
// untrusted; GIT_CONFIG_NOSYSTEM covers system config only.
//
// It also never pushes HEAD from a tree the agent commits into. An earlier version did
// `rebase FETCH_HEAD` then `push HEAD:main` in her working tree, which replayed any commit she
// had made locally onto the default branch under this credential: an unreviewed instruction-file
// change, pushed by a bypass actor, within the hour. Cloning fresh means the only commit on top
// of the branch tip is the one built below.
//
// TypeScript run through Node's native type stripping, same as scripts/check-persistent-mounts.mts.
// No build step and no transpiler; the image ships Node 24.
import { execFileSync } from "node:child_process"
import {
  writeFileSync,
  readFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
  lstatSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, basename } from "node:path"

const workspace = process.env.WORKSPACE_DIR ?? "/state/workspace"
const branch = process.env.TARGET_BRANCH ?? "main"
// No credential in the URL; see GIT_ASKPASS below. Overridable so this can be exercised
// against a throwaway local repo without touching GitHub.
const remote = process.env.REMOTE_URL ?? "https://github.com/activescott/activeassistant.git"
const tokenPath = process.env.GITHUB_PAT_FILE ?? "/etc/olya-sync/token"

// Only these paths. Everything else in the repo is an instruction file and reaches the default
// branch only through a reviewed PR. Copying by name rather than syncing the tree is what keeps
// an uncommitted instruction edit in her workspace from riding along into this commit.
const MEMORY_PATHS = ["MEMORY.md", "DREAMS.md", "USER.md", "IDENTITY.md", "memory/"]

if (!existsSync(tokenPath)) {
  console.error(`no token at ${tokenPath}; check the olya-memory-sync Secret and its volume`)
  process.exit(1)
}
const token = readFileSync(tokenPath, "utf8").trim()
if (!token) {
  console.error(`${tokenPath} is empty`)
  process.exit(1)
}

// The token is passed to git through GIT_ASKPASS rather than embedded in the remote URL.
// A URL-embedded credential shows up in the git process's argv, readable via ps and /proc, and
// git echoes the remote back in several error messages, so a failed push would print the token
// into the pod log where Alloy ships it to Loki for 180 days.
const askpassDir = mkdtempSync(join(tmpdir(), "olya-askpass-"))
const askpass = join(askpassDir, "askpass.sh")
const askpassToken = join(askpassDir, "token")
writeFileSync(askpassToken, token, { mode: 0o600 })
writeFileSync(
  askpass,
  `#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) cat ${JSON.stringify(askpassToken)} ;; esac\n`,
  { mode: 0o700 },
)
chmodSync(askpass, 0o700)
chmodSync(askpassToken, 0o600)

// The token is NOT in this process's environment (it is read from a projected file), so it
// reaches git only through the askpass script and is not inherited by unrelated children.
const gitEnv = {
  ...process.env,
  GIT_ASKPASS: askpass,
  GIT_TERMINAL_PROMPT: "0",
  // Belt and braces. The clone below is created by this job in an emptyDir, so there is no
  // attacker-supplied config or hook to find, but these cost nothing and keep that true if the
  // scratch path is ever moved onto shared storage.
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
}

const HARDEN = ["-c", "core.hooksPath=/dev/null"]

const scratch = mkdtempSync(join(tmpdir(), "olya-sync-"))
const clone = join(scratch, "repo")

function git(args: string[], opts: { cwd?: string; allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", [...HARDEN, ...args], {
      cwd: opts.cwd ?? clone,
      env: gitEnv,
      encoding: "utf8",
    }).trim()
  } catch (err) {
    if (opts.allowFail) return ""
    const e = err as { stderr?: string; message?: string }
    // Safe to print: with GIT_ASKPASS the credential is never in argv or in git's messages.
    console.error(`git ${args.join(" ")} failed: ${e.stderr ?? e.message}`)
    process.exit(1)
    // Unreachable. process.exit is typed as returning never only with @types/node, which this
    // repo deliberately does not install, so the throw is what makes the function total.
    throw new Error("unreachable")
  }
}

// Shallow: this only ever adds one commit on top of the branch tip, and pushing from a shallow
// clone is supported as long as the remote already has the history.
git(["clone", "--quiet", "--depth", "1", "--branch", branch, remote, clone], { cwd: scratch })

// Only regular files and directories are copied. Everything else in the source tree is skipped:
// symlinks, because git would store the link text rather than the target's contents; FIFOs,
// sockets and device nodes, because cpSync THROWS on them (ERR_FS_CP_FIFO_PIPE,
// ERR_FS_CP_SOCKET) and an uncaught throw here kills the job. `mkfifo` needs no privilege and
// /state/workspace is writable by the agent's uid, so one stray socket under memory/ would
// otherwise wedge the sync permanently while the CronJob went on failing quietly.
//
// A nested .git is excluded for the same reason it would be wrong: `git add -A` would record it
// as a gitlink pointing at a commit the remote does not have.
function copyable(p: string): boolean {
  try {
    const s = lstatSync(p)
    return (s.isFile() || s.isDirectory()) && basename(p) !== ".git"
  } catch {
    // Raced with the agent deleting it. She writes to this tree continuously, so this is
    // expected rather than exceptional.
    return false
  }
}

let copied = 0
for (const path of MEMORY_PATHS) {
  const src = join(workspace, path)
  const dest = join(clone, path)
  rmSync(dest, { recursive: true, force: true })
  if (!copyable(src)) continue
  try {
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true, dereference: false, filter: copyable })
    copied++
  } catch (err) {
    // One bad path must not cost the whole hour's sync. Skip it and keep the rest.
    const e = err as { message?: string }
    console.warn(`skipping ${path}: ${e.message}`)
    rmSync(dest, { recursive: true, force: true })
  }
}

// -A so a memory file she deleted is staged as a deletion. Pathspec matching considers the
// index, so a path that is tracked in the clone but absent in the workspace still matches;
// a path that is neither tracked nor present would abort the whole `git add`, which is how an
// earlier version silently synced nothing while looking like a healthy quiet hour.
const candidates = MEMORY_PATHS.filter(
  (p) => existsSync(join(clone, p)) || git(["ls-files", "--", p]) !== "",
)
if (candidates.length === 0) {
  console.log("no memory files exist yet")
  process.exit(0)
}
git(["add", "-A", "--", ...candidates])

const staged = git(["diff", "--cached", "--name-only"])
if (!staged) {
  console.log(`no memory changes (${copied} path(s) checked)`)
  process.exit(0)
}

// A distinct identity so machine snapshots are distinguishable from her own work in the log.
// Unsigned: no signing key here, which is why "require signed commits" must stay off on that
// repository.
git([
  "-c",
  "user.name=olya-memory-sync",
  "-c",
  "user.email=olya@pingpoet.com",
  "commit",
  "--quiet",
  "--no-gpg-sign",
  "-m",
  "sync memory",
])

// Assert the commit sits directly on the tip we cloned. Cheap check that nothing unexpected
// got into the history between the clone and here.
const parent = git(["rev-parse", "HEAD^"])
const tip = git(["rev-parse", `refs/remotes/origin/${branch}`])
if (parent !== tip) {
  console.error(`refusing to push: HEAD^ is ${parent}, expected origin/${branch} at ${tip}`)
  process.exit(1)
}

// Plain fast-forward, no --force. If Scott merged a PR since the clone, this fails and the next
// hour picks it up from the new tip.
git(["push", "--quiet", "origin", `HEAD:${branch}`])

console.log(`pushed ${staged.split("\n").length} file(s): ${git(["log", "--oneline", "-1"])}`)

rmSync(scratch, { recursive: true, force: true })
rmSync(askpassDir, { recursive: true, force: true })

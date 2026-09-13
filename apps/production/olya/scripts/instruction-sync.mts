#!/usr/bin/env -S node --experimental-strip-types
// Sidecar loop. Pulls instruction files from origin/main every 15 minutes.
//
// Memory files live only as working-tree files until the hourly sync pushes them, so they are
// copied aside before the reset destroys them and restored after.
//
// TypeScript run through Node's native type stripping, same as memory-sync.mts.
// No build step and no transpiler; the image ships Node 24.
import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = "/state"
const workspace = join(state, "workspace")
const home = join(state, "home")

// Memory files, preserved across the reset. Must match seed-workspace.sh.
const MEMORY_PATHS = ["MEMORY.md", "DREAMS.md", "USER.md", "IDENTITY.md", "memory"]

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ==> ${msg}`)
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    env: process.env,
    encoding: "utf8",
  }).trim()
}

function syncOnce(): void {
  git(["fetch", "origin", "main"])

  const head = git(["rev-parse", "HEAD"])
  const origin = git(["rev-parse", "origin/main"])
  if (head === origin) {
    log("no changes")
    return
  }

  log("detected instruction files changed in git:")
  for (const line of git(["diff", "--name-only", "HEAD", "origin/main"]).split("\n")) {
    if (line) console.log(`    ${line}`)
  }

  // Root filesystem is read-only, so /tmp (emptyDir mount) is the only scratch space.
  const saved = mkdtempSync(join(tmpdir(), "instruction-sync-"))
  for (const p of MEMORY_PATHS) {
    const src = join(workspace, p)
    if (existsSync(src)) cpSync(src, join(saved, p), { recursive: true })
  }

  git(["checkout", "--force", "-B", "main", "origin/main"])
  git(["clean", "-ffdx"])

  for (const p of MEMORY_PATHS) {
    const backup = join(saved, p)
    if (existsSync(backup)) {
      rmSync(join(workspace, p), { recursive: true, force: true })
      cpSync(backup, join(workspace, p), { recursive: true })
    }
  }
  rmSync(saved, { recursive: true, force: true })

  // The running gateway read its config at startup from /state, not from the workspace, so the
  // fresh copy has to be put where it is actually read from.
  copyFileSync(join(workspace, "openclaw.json"), join(state, "openclaw", "openclaw.json"))

  // Same copies seed-workspace.sh makes at boot. Copies, not symlinks; see there.
  const agentSrc = join(workspace, "subagents", "opencode", "AGENTS.md")
  if (existsSync(agentSrc) && lstatSync(agentSrc).isFile()) {
    copyFileSync(agentSrc, join(home, ".config", "opencode", "AGENTS.md"))
  }
  const claudeSrc = join(workspace, "subagents", "claude", "CLAUDE.md")
  if (existsSync(claudeSrc) && lstatSync(claudeSrc).isFile()) {
    copyFileSync(claudeSrc, join(home, ".claude", "CLAUDE.md"))
  }

  log(`synced workspace instructions to activescott/activeassistant @ ${origin}`)
}

// Give the main container time to finish starting before the first fetch.
await new Promise(resolve => setTimeout(resolve, 60_000))

while (true) {
  try {
    syncOnce()
  } catch (err) {
    // A failed fetch must not kill the sidecar. Log and retry on the next interval.
    const e = err as { message?: string }
    log(`sync failed, will retry: ${e.message ?? err}`)
  }
  await new Promise(resolve => setTimeout(resolve, 900_000))
}

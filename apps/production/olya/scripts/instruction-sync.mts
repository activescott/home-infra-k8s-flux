#!/usr/bin/env -S node --experimental-strip-types
// Sidecar loop. Pulls instruction files from origin/main every 15 minutes.
//
// This container mounts /state read-write with no read-only overlay, unlike the olya container
// beside it, which is what lets it write the paths she cannot. That asymmetry is the design.
//
// Memory files are not at risk from the reset: they live at /state/memory, outside the checkout.
// What the reset does destroy is the symlinks to them at workspace root, so those are rebuilt
// afterwards -- same paths and same reasoning as seed-workspace.sh, which plants them at boot.
//
// TypeScript run through Node's native type stripping, same as memory-sync.mts.
// No build step and no transpiler; the image ships Node 24.
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { join } from "node:path"

const state = "/state"
const workspace = join(state, "workspace")
const home = join(state, "home")
const memoryLive = join(state, "memory")
const configLive = join(state, "config")

// Memory paths, relative to both the repo root and /state/memory. Must match seed-workspace.sh.
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

  git(["checkout", "--force", "-B", "main", "origin/main"])
  git(["clean", "-ffdx"])

  // The reset just replaced the workspace-root symlinks with the regular files git tracks, so
  // put the links back. Seed any target that does not exist yet from what the checkout carries:
  // a write through a dangling symlink would create the target, but a READ of one fails, and
  // OpenClaw reads IDENTITY.md and USER.md from workspace root.
  mkdirSync(join(memoryLive, "memory"), { recursive: true })
  for (const p of MEMORY_PATHS) {
    const live = join(memoryLive, p)
    const link = join(workspace, p)
    if (!existsSync(live) && existsSync(link)) {
      cpSync(link, live, { recursive: true })
    }
    rmSync(link, { recursive: true, force: true })
    symlinkSync(live, link)
  }

  // The gateway reads its config from /state/config, not from the workspace, so the fresh copy
  // has to be put where it is actually read from.
  //
  // copyFileSync overwrites in place and keeps the inode, which the gateway's inotify watch
  // depends on. Do NOT switch this to unlink-and-recreate, and do not point the gateway at the
  // workspace copy instead: the `git checkout --force` above swaps that file's inode, so the
  // watch would silently follow the old one and stop noticing config changes.
  copyFileSync(join(workspace, "openclaw.json"), join(configLive, "openclaw.json"))

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

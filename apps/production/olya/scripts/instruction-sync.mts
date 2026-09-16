#!/usr/bin/env -S node --experimental-strip-types
// Sidecar loop. Pulls instruction files from origin/main every 15 minutes.
//
// This container mounts /state read-write with no read-only overlay, unlike the olya container
// beside it, which is what lets it write the paths she cannot. That asymmetry is the design.
//
// The reset does not touch memory. The memory files live at MEMORY_LIVE, outside the checkout,
// and reach workspace root as bind mounts that exist only in the olya container's mount
// namespace -- so `git clean -ffdx` here sees the ordinary tracked files it expects, resets
// them, and the mounts beside it are unaffected. Nothing to preserve and nothing to rebuild.
//
// TypeScript run through Node's native type stripping, same as memory-sync.mts.
// No build step and no transpiler; the image ships Node 24.
import { execFileSync } from "node:child_process"
import { WORKSPACE, installSubagentFiles, publishConfig } from "./volume-layout.mts"

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ==> ${msg}`)
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: WORKSPACE,
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

  // The same two steps seed-workspace.mts runs after its own reset, in the same order.
  publishConfig()
  installSubagentFiles()

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

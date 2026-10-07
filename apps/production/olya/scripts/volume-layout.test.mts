import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { syncCheckoutToOrigin } from "./volume-layout.mts"

// Isolated from whatever git config the machine running this has: no signing, no hooks.
const root = mkdtempSync(join(tmpdir(), "volume-layout-"))
writeFileSync(join(root, "gitconfig"), "")
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
})

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
}

function commitFile(dir: string, path: string, content: string): void {
  writeFileSync(join(dir, path), content)
  git(dir, "add", path)
  git(dir, "commit", "--quiet", "-m", `write ${path}`)
  git(dir, "push", "--quiet", "origin", "main")
}

test("a path that left MEMORY_PATHS loses skip-worktree and is restored from HEAD", () => {
  const origin = join(root, "origin.git")
  const upstream = join(root, "upstream")
  const checkout = join(root, "checkout")
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin)
  git(root, "clone", "--quiet", origin, upstream)
  git(upstream, "checkout", "--quiet", "-b", "main")
  writeFileSync(join(upstream, "MEMORY.md"), "memory v1\n")
  git(upstream, "add", "MEMORY.md")
  commitFile(upstream, "IDENTITY.md", "identity v1\n")
  git(root, "clone", "--quiet", "--branch", "main", origin, checkout)

  // The state a previous sync leaves behind while IDENTITY.md was still a memory file: flagged,
  // its checkout copy never written again, and the index following origin.
  git(checkout, "update-index", "--skip-worktree", "--", "MEMORY.md", "IDENTITY.md")
  writeFileSync(join(checkout, "IDENTITY.md"), "stale\n")
  writeFileSync(join(checkout, "MEMORY.md"), "live memory\n")

  syncCheckoutToOrigin(checkout, "main")

  assert.equal(readFileSync(join(checkout, "IDENTITY.md"), "utf8"), "identity v1\n")
  assert.equal(git(checkout, "ls-files", "-v", "IDENTITY.md"), "H IDENTITY.md")
  // A path still in MEMORY_PATHS keeps both the flag and its worktree content.
  assert.equal(git(checkout, "ls-files", "-v", "MEMORY.md"), "S MEMORY.md")
  assert.equal(readFileSync(join(checkout, "MEMORY.md"), "utf8"), "live memory\n")

  // Once released, it follows origin like any other instruction file.
  commitFile(upstream, "IDENTITY.md", "identity v2\n")
  syncCheckoutToOrigin(checkout, "main")
  assert.equal(readFileSync(join(checkout, "IDENTITY.md"), "utf8"), "identity v2\n")
  assert.equal(git(checkout, "status", "--porcelain"), "")
})

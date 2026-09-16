#!/usr/bin/env -S node --experimental-strip-types
// Runs as a postStart hook on the olya container. Proves the memory bind mounts are actually in
// place, and kills the container if they are not.
//
// This has to run HERE and cannot live in seed-workspace. The mounts exist only in the olya
// container's mount namespace, so the initContainer cannot see them; and seed-workspace creates
// the very files it would be asserting on, so any check it made would pass whether or not the
// StatefulSet mounted them.
//
// The failure it exists to catch: MEMORY_PATHS and the volumeMounts in olya-statefulset.yaml
// have to agree, across two files, and kubelet cannot read a TypeScript constant. Add a memory
// path without adding its mount and everything looks healthy -- the gateway reads the read-only
// checkout copy, her writes to it fail or land somewhere nothing reads, and the hourly sync
// pushes an untouched file. No error anywhere. That is the exact class of silent failure the
// read-only workspace work exists to remove, so this fails loudly instead.
//
// Exiting non-zero makes kubelet kill the container, which is deliberate and consistent with the
// rest of this deployment: OpenClaw refuses to start on an invalid config, memory-sync refuses to
// run against a missing directory, seed-workspace exits on an unreadable ssh key. A crashloop is
// a worse outcome than a working assistant and a better one than an assistant silently losing
// its memory.
import { accessSync, constants, lstatSync, statSync } from "node:fs"
import { join } from "node:path"
import { MEMORY_DIRECTORIES, MEMORY_LIVE, MEMORY_PATHS, WORKSPACE } from "./volume-layout.mts"

const problems: string[] = []

for (const path of MEMORY_PATHS) {
  const inWorkspace = join(WORKSPACE, path)
  const source = join(MEMORY_LIVE, path)

  try {
    // A symlink here is the 2026-09-16 regression returning: OpenClaw refuses to read bootstrap
    // files through one, and memory-core refuses to write a symlinked DREAMS.md.
    if (lstatSync(inWorkspace).isSymbolicLink()) {
      problems.push(`${inWorkspace} is a symlink; it must be a bind mount of ${source}`)
      continue
    }

    // Same inode means the mount is there. Different inodes mean the workspace path is the
    // read-only checkout copy and the mount is missing.
    const mounted = statSync(inWorkspace)
    const live = statSync(source)
    if (mounted.ino !== live.ino || mounted.dev !== live.dev) {
      problems.push(
        `${inWorkspace} is not bind-mounted from ${source} ` +
          `(inode ${mounted.ino} vs ${live.ino}); add its volumeMount to olya-statefulset.yaml`,
      )
      continue
    }

    // Matching inodes are NOT sufficient on their own, and both gaps below are silent.
    //
    // A mount carrying readOnly: true -- an easy copy-paste from the two read-only mounts these
    // sit between -- has identical inodes and fails every write. And if the source is deleted
    // while the pod runs, a later container restart WITHOUT pod recreation makes kubelet create
    // a root-owned directory at the subPath source; both paths are then that same directory, so
    // inodes match, while the type is wrong and it is unwritable. initContainers do not rerun on
    // a container restart, so seedMemoryFromCheckout's type assertion cannot catch that one.
    const wantDirectory = MEMORY_DIRECTORIES.has(path)
    const isRight = wantDirectory ? mounted.isDirectory() : mounted.isFile()
    if (!isRight) {
      problems.push(
        `${inWorkspace} is not a ${wantDirectory ? "directory" : "regular file"}; ` +
          `kubelet creates a directory for a subPath source that does not exist`,
      )
      continue
    }

    // access(2) reports EROFS on a read-only mount even when the permission bits allow writing,
    // which is what makes this catch a stray readOnly: true rather than only a chmod.
    accessSync(inWorkspace, constants.W_OK)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e.code === "ENOENT") {
      problems.push(
        `${inWorkspace} does not exist; track it in activescott/activeassistant so the ` +
          `checkout provides the mountpoint, and add its volumeMount to olya-statefulset.yaml`,
      )
    } else if (e.code === "EROFS" || e.code === "EACCES") {
      problems.push(`${inWorkspace} is not writable (${e.code}); check readOnly on its volumeMount`)
    } else {
      problems.push(`${inWorkspace}: ${e.message ?? String(err)}`)
    }
  }
}

if (problems.length > 0) {
  console.error("FATAL: memory mounts are wrong, refusing to run:")
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`==> memory mounts verified (${MEMORY_PATHS.length} path(s))`)

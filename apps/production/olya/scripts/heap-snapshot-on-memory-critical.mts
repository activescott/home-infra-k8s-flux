// Preloaded into the gateway with --import (see the olya container's args). Writes a V8 heap
// snapshot when the gateway reports critical memory pressure, so the next heap spike like
// activescott/activeassistant#720 records what was growing.
//
// The trigger is OpenClaw's own `openclaw.memory.critical` diagnostics channel, which it
// publishes on every memory sample at level=critical, the same check that logs
// `memory pressure: level=critical`. Its worker pools subscribe to it too. Subscribing in-process
// avoids a sidecar that would have to match the log wording. Node's
// --heapsnapshot-near-heap-limit does not cover this: it fires only near the 4 GiB heap limit,
// and the 2026-10-03 and 2026-10-05 spikes went critical at a 1.3-1.5 GiB heap.
//
// writeHeapSnapshot blocks the main thread until V8 finishes, tens of seconds for a heap this
// size, so three limits keep this from causing the stalls it is meant to explain:
// - MIN_HEAP_BYTES. Most critical samples are RSS at about 3 GiB over a 500 MiB heap, which is
//   native memory a heap snapshot cannot show. Only a heap that has grown is worth the stall.
// - COOLDOWN_MS between snapshots in one process.
// - KEEP files on disk, oldest deleted first, so repeated restarts cannot fill the volume.
//
// Every failure is caught. An exception thrown from a channel subscriber is rethrown as an
// uncaught exception, which would take the gateway down.
import { subscribe } from "node:diagnostics_channel"
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { writeHeapSnapshot } from "node:v8"

// The directory OpenClaw's own diagnostics.heapSnapshot RPC writes to.
const DIRECTORY = join(process.env.OPENCLAW_STATE_DIR ?? "/state/openclaw", "diagnostics")
const PREFIX = "memory-critical-"
const MIN_HEAP_BYTES = 1024 ** 3
const COOLDOWN_MS = 60 * 60 * 1000
const KEEP = 3

let nextAt = 0
let pending = false

function log(message: string): void {
  process.stderr.write(`heap-snapshot-on-memory-critical: ${message}\n`)
}

function prune(): void {
  const snapshots = readdirSync(DIRECTORY)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(".heapsnapshot"))
    .map((name) => ({ path: join(DIRECTORY, name), mtime: statSync(join(DIRECTORY, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const old of snapshots.slice(KEEP)) unlinkSync(old.path)
}

function capture(): void {
  pending = false
  try {
    const heapUsed = process.memoryUsage().heapUsed
    if (heapUsed < MIN_HEAP_BYTES) return
    nextAt = Date.now() + COOLDOWN_MS
    mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 })
    const path = join(DIRECTORY, `${PREFIX}${new Date().toISOString().replaceAll(":", "-")}.heapsnapshot`)
    log(`writing ${path} at heapUsed=${heapUsed}; the main thread blocks until it finishes`)
    const startedAt = Date.now()
    writeHeapSnapshot(path)
    log(`wrote ${path} (${statSync(path).size} bytes) in ${Date.now() - startedAt}ms`)
    prune()
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

subscribe("openclaw.memory.critical", () => {
  if (pending || Date.now() < nextAt) return
  pending = true
  // Out of OpenClaw's memory sample call, so its own pressure log line is written first.
  setImmediate(capture)
})

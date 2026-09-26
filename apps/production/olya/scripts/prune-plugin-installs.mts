#!/usr/bin/env -S node --experimental-strip-types
// Removes the plugin installs install-plugins and earlier runtime installs left in
// $OPENCLAW_STATE_DIR, now that every plugin olya-0 runs is baked into the image as bundled
// (activescott/activeassistant#386). An install record is origin global, and global outranks
// bundled, so a stale record keeps loading the old copy and the image's copy is ignored.
// Idempotent, and a no-op once the records are gone; delete this container after one boot's log
// shows it pruned.
//
// A plugin in REPLACED is removed only when the image has its bundled copy, since on an older
// image the record is the only copy there is. perplexity was most likely installed by doctor's
// automatic repair on 2026-09-13, and nothing uses it.
//
// Like install-plugins before it, this always exits 0 (Scott, 2026-09-24): a failed prune leaves
// the old copy loading, which is how olya-0 already runs, and must not wedge the pod. Grep the log
// for "prune-plugin-installs: WARNING".
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

process.on("uncaughtException", (err: unknown) => {
  console.log(`prune-plugin-installs: WARNING stopped early: ${err}`)
  process.exit(0)
})

const REPLACED = ["acpx", "diagnostics-prometheus", "slack"]
const DROPPED = ["perplexity"]

const UNINSTALL_TIMEOUT_MS = 10 * 60 * 1000

const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw")

// The bundled root is dist/extensions in the package the openclaw on PATH runs from, which is
// /app in the image.
const bundledDir = join(
  dirname(realpathSync(execFileSync("sh", ["-c", "command -v openclaw"], { encoding: "utf8" }).trim())),
  "dist",
  "extensions",
)

// Every openclaw call runs against an empty config. Records live in the state dir, so inspect
// finds them whatever the seeded config says, and uninstall also strips the plugin from the
// config it is given (channels.<id>, its allowlist entry and its entry), which must not be the
// seeded one. Its own directory, because OpenClaw writes and chmods siblings of the config file.
const scratchDir = mkdtempSync(join(tmpdir(), "prune-plugin-installs-"))
process.env.OPENCLAW_CONFIG_PATH = join(scratchDir, "openclaw.json")
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, "{}\n")

function log(msg: string) {
  console.log(`prune-plugin-installs: ${msg}`)
}

type Inspection = { origin?: string; trustReason?: string; installSource?: string; installPath?: string; failure?: string }

function inspect(id: string): Inspection {
  let output: string
  let failure: string | undefined
  try {
    output = execFileSync("openclaw", ["plugins", "inspect", id, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null; signal?: string | null }
    output = e.stdout ?? ""
    failure = e.signal ? `killed by ${e.signal}` : `exit ${e.status}`
  }
  let result
  try {
    result = JSON.parse(output)
  } catch {
    return { failure: failure ?? "unparseable output" }
  }
  if (result?.error?.message?.startsWith("Plugin not found")) return {}
  const { plugin, install } = result ?? {}
  if (plugin === undefined && install === undefined && failure !== undefined) return { failure }
  return {
    origin: plugin?.origin,
    trustReason: plugin?.trust?.reason,
    installSource: install?.source,
    installPath: install?.installPath?.replace(/^~(?=$|\/)/, homedir()),
  }
}

function uninstall(id: string): boolean {
  try {
    execFileSync("openclaw", ["plugins", "uninstall", id, "--force"], {
      stdio: "inherit",
      timeout: UNINSTALL_TIMEOUT_MS,
    })
    return true
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null }
    log(`WARNING ${id} uninstall failed (${e.signal ? `killed by ${e.signal}` : `exit ${e.status}`})`)
    return false
  }
}

for (const id of [...REPLACED, ...DROPPED]) {
  const before = inspect(id)
  if (before.failure !== undefined) {
    log(`WARNING ${id} inspect failed (${before.failure}); leaving it`)
    continue
  }
  if (before.installPath === undefined || before.installPath.startsWith(bundledDir + "/")) {
    log(`${id} has no install record; nothing to remove`)
    continue
  }
  if (REPLACED.includes(id) && !existsSync(join(bundledDir, id, "openclaw.plugin.json"))) {
    log(`WARNING ${id} has no bundled copy in ${bundledDir}; keeping the ${before.installSource} install`)
    continue
  }
  log(`${id} removing ${before.installSource} install at ${before.installPath}`)
  if (!uninstall(id)) continue
  const after = inspect(id)
  log(`${id} removed; now origin ${after.origin ?? "none"}, trust ${after.trustReason ?? "none"}`)
}

// What is left once the records are gone: staging dirs from killed installs, install-plugins'
// failures file, and the install roots themselves if nothing else is in them.
const projects = join(stateDir, "npm", "projects")
if (existsSync(projects)) {
  for (const name of readdirSync(projects)) {
    if (!name.startsWith(".openclaw-install-stage-")) continue
    log(`removing leftover ${join(projects, name)}`)
    rmSync(join(projects, name), { recursive: true, force: true })
  }
}
const failuresFile = join(stateDir, "install-plugins-failures.json")
if (existsSync(failuresFile)) {
  log(`removing ${failuresFile}`)
  rmSync(failuresFile, { force: true })
}
for (const dir of [projects, join(stateDir, "npm"), join(stateDir, "extensions")]) {
  if (!existsSync(dir)) continue
  const left = readdirSync(dir)
  if (left.length > 0) {
    log(`keeping ${dir}: ${left.join(", ")}`)
    continue
  }
  log(`removing empty ${dir}`)
  rmdirSync(dir)
}
rmSync(scratchDir, { recursive: true, force: true })
process.exit(0)

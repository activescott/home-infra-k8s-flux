#!/usr/bin/env -S node --experimental-strip-types
// Installs managed plugins listed in /cfg/managed-plugins.txt.
// Idempotent: skips plugins whose trust record already exists at the pinned version.
//
// A failed upgrade does not block boot. If the pinned version fails to install (non-zero exit,
// OOMKill, timeout) but an earlier version is still installed, this logs a WARNING line and
// exits 0 so olya-0 boots on the old version. The same goes when inspect itself cannot run: the
// plugin is left as it is.
//
// It always exits 0, even when an install fails and leaves the plugin with no usable install.
// Scott decided on 2026-09-24 that a plugin that fails to install must never wedge the pod: it
// comes up without that plugin, so a restart always gets Olya back partially working. That case
// logs an "install-plugins: ERROR" line and is written to $OPENCLAW_STATE_DIR/
// install-plugins-failures.json for the main container to surface; a clean run removes the file.
// Grep the init container log for "install-plugins: WARNING" and "install-plugins: ERROR".
//
// A line starting with "-" removes that package's managed install instead, and only when the
// install record names that package. This is how a plugin moves into the image: a managed copy
// is origin global and outranks the bundled one, so leaving it would shadow the image's copy.
// On an image without that copy it is kept: inspect would reinstall it from the official
// catalog straight away.
import { execFileSync } from "node:child_process"
import { copyFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

const pluginsFile = "/cfg/managed-plugins.txt"
if (!existsSync(pluginsFile)) {
  console.log(`install-plugins: no ${pluginsFile} found; nothing to install`)
  process.exit(0)
}

// The --force reinstall ran ~5min before its 1Gi OOMKill (#204). Long enough for that path to
// finish at 2Gi, short enough that a hung npm doesn't hold the pod in Init indefinitely.
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

const failuresFile = join(
  process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"),
  "install-plugins-failures.json",
)

// Trust reasons that mean the loaded copy is the one openKeyedStore accepts. Anything else, e.g.
// record-missing for a copy loaded from a plugins.load.paths entry, needs a managed install.
const TRUSTED = new Set(["trusted-official", "bundled"])

// Where the image's OpenClaw looks for bundled plugins.
const BUNDLED_EXTENSIONS = "/app/dist/extensions"

// failure is set when inspect could not say what is installed: it was killed (a starved
// container OOMKills it before any install starts), or exited non-zero without a result.
// Output from a successful inspect that doesn't parse is treated as nothing installed.
type Inspection = {
  loadedVersion?: string
  trustReason?: string
  origin?: string
  installedName?: string
  installedVersion?: string
  installPath?: string
  failure?: string
}

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
    return failure !== undefined ? { failure } : {}
  }
  // What inspect prints for a plugin with nothing installed, e.g. an empty $OPENCLAW_STATE_DIR.
  if (result?.error?.message?.startsWith("Plugin not found")) return {}
  const { plugin, install } = result ?? {}
  if (plugin === undefined && failure !== undefined) return { failure }
  return {
    loadedVersion: plugin?.version,
    trustReason: plugin?.trust?.reason,
    origin: plugin?.origin,
    installedName: install?.resolvedName,
    installedVersion: install?.resolvedVersion,
    installPath: install?.installPath?.replace(/^~(?=$|\/)/, homedir()),
  }
}

// openclaw stages the npm install in a sibling directory and only swaps it in once it
// succeeds, so a failed or killed install normally leaves the old copy in place. The swap
// itself is two renames, and a kill between them would leave a record pointing at nothing,
// so after a failure this re-inspects and checks the files are still there. A copy loaded from
// a config path has no install record but still loads, untrusted, so it counts too.
function usableVersion(id: string): string | undefined {
  const { loadedVersion, installedVersion, installPath } = inspect(id)
  const version = installedVersion ?? loadedVersion
  if (version === undefined) return undefined
  if (installPath !== undefined && !existsSync(join(installPath, "package.json"))) return undefined
  return version
}

// Uninstall also strips the plugin from whatever config it is pointed at: channels.<id>, its
// allowlist entry and its entry. The record and files live in $OPENCLAW_STATE_DIR, so it runs
// against a throwaway copy and the seeded config is left alone.
function removeManagedInstall(spec: string) {
  const pkg = spec.replace(/^npm:/, "").replace(/@[\d][^@]*$/, "")
  const id = pkg.replace(/^.*\//, "")
  const { installedName, failure } = inspect(id)
  if (failure !== undefined) {
    console.log(`install-plugins: WARNING ${id} inspect failed (${failure}); not removing anything`)
    return
  }
  if (installedName !== pkg) {
    console.log(`install-plugins: ${id} has no managed ${pkg} install; nothing to remove`)
    return
  }
  if (!existsSync(join(BUNDLED_EXTENSIONS, id, "openclaw.plugin.json"))) {
    console.log(
      `install-plugins: WARNING ${id} has no bundled copy in this image; keeping managed ${pkg}`,
    )
    return
  }
  console.log(`install-plugins: ${id} removing managed ${pkg} install`)
  const configPath = process.env.OPENCLAW_CONFIG_PATH
  // Its own directory, because OpenClaw writes and chmods siblings of the config file.
  const scratchDir = mkdtempSync(join(tmpdir(), `install-plugins-${id}-`))
  const scratchConfig = join(scratchDir, "openclaw.json")
  try {
    if (configPath !== undefined && existsSync(configPath)) copyFileSync(configPath, scratchConfig)
    else writeFileSync(scratchConfig, "{}\n")
    execFileSync("openclaw", ["plugins", "uninstall", id, "--force"], {
      stdio: "inherit",
      timeout: INSTALL_TIMEOUT_MS,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: scratchConfig },
    })
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null }
    const how = e.signal ? `killed by ${e.signal}` : `exit ${e.status}`
    console.log(`install-plugins: WARNING ${id} uninstall of ${pkg} failed (${how}); it still shadows the image copy`)
    return
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
  const after = inspect(id)
  console.log(
    `install-plugins: ${id} removed managed ${pkg}; now origin ${after.origin ?? "none"}, trust ${after.trustReason ?? "none"}`,
  )
}

const failures: { plugin: string; pinnedVersion?: string; cause: string; time: string }[] = []
const lines = readFileSync(pluginsFile, "utf8").split("\n")

for (const line of lines) {
  const spec = line.trim()
  if (!spec || spec.startsWith("#")) continue
  if (spec.startsWith("-")) {
    removeManagedInstall(spec.slice(1))
    continue
  }

  // @openclaw/acpx@2026.9.4 -> acpx
  const id = spec.replace(/@[\d].*$/, "").replace(/^.*\//, "")
  // @openclaw/acpx@2026.9.4 -> 2026.9.4
  const pinnedVersion = spec.match(/@([\d][^@]*)$/)?.[1]

  // A present record only proves *some* version was installed. bumping the pin in
  // managed-plugins.txt doesn't invalidate the old record, so without comparing
  // versions this install skips forever and the plugin never actually upgrades.
  const { loadedVersion, trustReason, installedVersion, failure } = inspect(id)
  const trusted = trustReason !== undefined && TRUSTED.has(trustReason)
  const version = installedVersion ?? loadedVersion

  if (failure !== undefined) {
    // Installing blind could only make this worse: if the install fails too, there is no way to
    // tell a kept copy from none, and a copy that was fine would block boot.
    console.log(
      `install-plugins: WARNING ${id} inspect failed (${failure}); keeping whatever is installed`,
    )
  } else if (version === undefined || !trusted || version !== pinnedVersion) {
    const reason =
      version === undefined
        ? "not installed"
        : !trusted
          ? `trust ${trustReason ?? "unknown"} at ${version}`
          : `installed version ${version} != pinned ${pinnedVersion}`
    console.log(`install-plugins: ${id} ${reason}; installing ${spec}`)
    try {
      execFileSync("openclaw", ["plugins", "install", spec, "--accept-capabilities", "--force"], {
        stdio: "inherit",
        timeout: INSTALL_TIMEOUT_MS,
      })
    } catch (err) {
      const e = err as { status?: number | null; signal?: string | null }
      const how = e.signal ? `killed by ${e.signal}` : `exit ${e.status}`
      const kept = usableVersion(id)
      if (kept !== undefined) {
        console.log(
          `install-plugins: WARNING ${id} upgrade to ${pinnedVersion} failed (${how}); keeping ${kept}`,
        )
      } else {
        console.error(
          `install-plugins: ERROR ${id} pinned ${pinnedVersion} failed to install (${how}) and no usable version is installed; continuing without it`,
        )
        failures.push({ plugin: id, pinnedVersion, cause: how, time: new Date().toISOString() })
      }
    }
  } else {
    console.log(`install-plugins: ${id} trust record present at ${version}; skipping`)
  }
}

try {
  if (failures.length > 0) {
    mkdirSync(dirname(failuresFile), { recursive: true })
    writeFileSync(failuresFile, JSON.stringify(failures, null, 2) + "\n")
  } else {
    rmSync(failuresFile, { force: true })
  }
} catch (err) {
  console.error(`install-plugins: ERROR could not update ${failuresFile}: ${err}`)
}
process.exit(0)

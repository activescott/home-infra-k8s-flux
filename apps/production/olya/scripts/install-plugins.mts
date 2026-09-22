#!/usr/bin/env -S node --experimental-strip-types
// Installs managed plugins listed in /cfg/managed-plugins.txt.
// Idempotent: skips plugins whose trust record already exists at the pinned version.
//
// A failed upgrade does not block boot. If the pinned version fails to install (non-zero exit,
// OOMKill, timeout) but an earlier version is still installed, this logs a WARNING line and
// exits 0 so olya-0 boots on the old version. It exits non-zero only when a plugin is left with
// no usable install at all. Grep the init container log for "install-plugins: WARNING".
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const pluginsFile = "/cfg/managed-plugins.txt"
if (!existsSync(pluginsFile)) {
  console.log(`install-plugins: no ${pluginsFile} found; nothing to install`)
  process.exit(0)
}

// The --force reinstall ran ~5min before its 1Gi OOMKill (#204). Long enough for that path to
// finish at 2Gi, short enough that a hung npm doesn't hold the pod in Init indefinitely.
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

type Inspection = { missingRecord: boolean; installedVersion?: string; installPath?: string }

function inspect(id: string): Inspection {
  let output: string
  try {
    output = execFileSync("openclaw", ["plugins", "inspect", id, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    output = ""
  }

  const missingRecord = output.includes('"reason":"record-missing"')
  if (missingRecord) return { missingRecord }
  try {
    const install = JSON.parse(output)?.install
    return {
      missingRecord,
      installedVersion: install?.resolvedVersion,
      installPath: install?.installPath?.replace(/^~(?=$|\/)/, homedir()),
    }
  } catch {
    return { missingRecord }
  }
}

// openclaw stages the npm install in a sibling directory and only swaps it in once it
// succeeds, so a failed or killed install normally leaves the old copy in place. The swap
// itself is two renames, and a kill between them would leave a record pointing at nothing,
// so after a failure this re-inspects and checks the files are still there.
function usableVersion(id: string): string | undefined {
  const { installedVersion, installPath } = inspect(id)
  if (installedVersion === undefined) return undefined
  if (installPath !== undefined && !existsSync(join(installPath, "package.json"))) return undefined
  return installedVersion
}

let failed = false
const lines = readFileSync(pluginsFile, "utf8").split("\n")

for (const line of lines) {
  const spec = line.trim()
  if (!spec || spec.startsWith("#")) continue

  // @openclaw/acpx@2026.9.4 -> acpx
  const id = spec.replace(/@[\d].*$/, "").replace(/^.*\//, "")
  // @openclaw/acpx@2026.9.4 -> 2026.9.4
  const pinnedVersion = spec.match(/@([\d][^@]*)$/)?.[1]

  // A present record only proves *some* version was installed. bumping the pin in
  // managed-plugins.txt doesn't invalidate the old record, so without comparing
  // versions this install skips forever and the plugin never actually upgrades.
  //
  // No version covers "Plugin not found" as well as a missing record: on an empty
  // $OPENCLAW_STATE_DIR inspect reports the former, and skipping there never installs at all.
  const { missingRecord, installedVersion } = inspect(id)

  if (installedVersion !== pinnedVersion) {
    const reason = missingRecord
      ? "trust record missing"
      : installedVersion === undefined
        ? "not installed"
        : `installed version ${installedVersion} != pinned ${pinnedVersion}`
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
          `install-plugins: ERROR ${id} install of ${pinnedVersion} failed (${how}) and no usable version is installed`,
        )
        failed = true
      }
    }
  } else {
    console.log(`install-plugins: ${id} trust record present at ${installedVersion}; skipping`)
  }
}

process.exit(failed ? 1 : 0)

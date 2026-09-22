#!/usr/bin/env -S node --experimental-strip-types
// Installs managed plugins listed in /cfg/managed-plugins.txt.
// Idempotent: skips plugins whose trust record already exists at the pinned version.
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"

const pluginsFile = "/cfg/managed-plugins.txt"
if (!existsSync(pluginsFile)) {
  console.log(`install-plugins: no ${pluginsFile} found; nothing to install`)
  process.exit(0)
}

const lines = readFileSync(pluginsFile, "utf8").split("\n")

for (const line of lines) {
  const spec = line.trim()
  if (!spec || spec.startsWith("#")) continue

  // @openclaw/acpx@2026.9.4 -> acpx
  const id = spec.replace(/@[\d].*$/, "").replace(/^.*\//, "")
  // @openclaw/acpx@2026.9.4 -> 2026.9.4
  const pinnedVersion = spec.match(/@([\d][^@]*)$/)?.[1]

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

  // A present record only proves *some* version was installed. bumping the pin in
  // managed-plugins.txt doesn't invalidate the old record, so without comparing
  // versions this install skips forever and the plugin never actually upgrades.
  let installedVersion: string | undefined
  if (!missingRecord) {
    try {
      installedVersion = JSON.parse(output)?.install?.resolvedVersion
    } catch {
      installedVersion = undefined
    }
  }
  const versionMismatch = installedVersion !== undefined && installedVersion !== pinnedVersion

  if (missingRecord || versionMismatch) {
    const reason = missingRecord
      ? "trust record missing"
      : `installed version ${installedVersion} != pinned ${pinnedVersion}`
    console.log(`install-plugins: ${id} ${reason}; installing ${spec}`)
    execFileSync("openclaw", ["plugins", "install", spec, "--accept-capabilities", "--force"], {
      stdio: "inherit",
    })
  } else {
    console.log(`install-plugins: ${id} trust record present at ${pinnedVersion}; skipping`)
  }
}

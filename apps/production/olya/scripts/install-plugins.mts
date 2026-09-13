#!/usr/bin/env -S node --experimental-strip-types
// Installs managed plugins listed in /cfg/managed-plugins.txt.
// Idempotent: skips plugins whose trust record already exists.
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

  let output: string
  try {
    output = execFileSync("openclaw", ["plugins", "inspect", id, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    output = ""
  }

  if (output.includes('"reason":"record-missing"')) {
    console.log(`install-plugins: ${id} trust record missing; installing ${spec}`)
    execFileSync("openclaw", ["plugins", "install", spec, "--accept-capabilities"], {
      stdio: "inherit",
    })
  } else {
    console.log(`install-plugins: ${id} trust record present; skipping`)
  }
}

#!/usr/bin/env -S node --experimental-strip-types
// Sets shared GitHub Actions secrets on every repo that needs them. GitHub personal
// accounts have no organization secrets, so scripts/actions-secrets.json lists, per secret,
// where its value lives and which repos get it.
//
// A value comes from a sops-encrypted dotenv file in this repo (read through
// onepassword-secrets.mts show) or from `op read <reference>`. It reaches `gh secret set` on
// stdin. It is never passed as an argument, logged, or written to disk.
//
// Each secret is set once per entry in its "apps" list (default: actions and dependabot).
// The plain Actions secret covers pushes and same-repo contributor PRs. The dependabot one
// is a separate, narrower store that Dependabot-triggered runs use instead (the "Secret
// source: Dependabot" line in a job's setup log). Having only the former means every
// Dependabot PR's jobs silently get an empty value.
//
// Repos are not discoverable from this repo, so the lists are maintained by hand: add a repo
// the day its CI starts using the secret (grep its .github/workflows for the secret name).
//
// Usage:
//   ./scripts/sync-actions-secrets.mts [--dry-run] [--secret <NAME>] [--repo <owner/name>]
//
// Exits 1 if any repo failed.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const CONFIG_PATH = "scripts/actions-secrets.json"

const OK = "✅"
const BAD = "❌"

type Source = { sops: string; key: string } | { op: string }

const APPS = ["actions", "dependabot"] as const
type App = (typeof APPS)[number]

interface SecretConfig {
  source: Source
  repos: string[]
  apps: App[]
}

interface CommandResult {
  status: number
  stdout: Buffer
  stderr: string
}

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message)
}

function note(message: string): void {
  console.error(message)
}

/** stdout may hold a secret; callers must never log it. Only stderr is surfaced. */
function run(command: string, args: string[], input?: string): CommandResult {
  const result = spawnSync(command, args, { input, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined
    if (code === "ENOENT") fail(`${command} not found on PATH`)
    fail(`${command} failed to start: ${result.error.message}`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString(),
  }
}

function loadConfig(repoRoot: string): Record<string, SecretConfig> {
  const path = join(repoRoot, CONFIG_PATH)
  let parsed: { secrets?: Record<string, Partial<SecretConfig>> }
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    fail(`cannot read ${CONFIG_PATH}: ${(error as Error).message}`)
  }
  const secrets: Record<string, SecretConfig> = {}
  for (const [name, entry] of Object.entries(parsed.secrets ?? {})) {
    const source = entry.source as Record<string, unknown> | undefined
    const isSops = typeof source?.sops === "string" && typeof source?.key === "string"
    const isOp = typeof source?.op === "string"
    if (!isSops && !isOp) {
      fail(`${name}: source must be { "sops": <file>, "key": <name> } or { "op": <op:// reference> }`)
    }
    if (!Array.isArray(entry.repos) || entry.repos.length === 0) {
      fail(`${name}: repos must be a non-empty list`)
    }
    for (const repo of entry.repos) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`${name}: "${repo}" is not <owner>/<name>`)
    }
    const apps = (entry as { apps?: unknown }).apps ?? ["actions", "dependabot"]
    if (!Array.isArray(apps) || apps.length === 0 || apps.some((app) => !APPS.includes(app))) {
      fail(`${name}: apps must be a non-empty list of ${APPS.join(", ")}`)
    }
    secrets[name] = { source: source as unknown as Source, repos: entry.repos, apps }
  }
  if (Object.keys(secrets).length === 0) fail(`${CONFIG_PATH} lists no secrets`)
  return secrets
}

function preflight(secrets: Record<string, SecretConfig>, repoRoot: string): void {
  const auth = run("gh", ["auth", "status"])
  if (auth.status !== 0) fail(`gh is not logged in:\n${auth.stderr.trim()}`)
  for (const [name, { source }] of Object.entries(secrets)) {
    if ("sops" in source && !existsSync(join(repoRoot, source.sops))) {
      fail(`${name}: ${source.sops} does not exist`)
    }
  }
  if (Object.values(secrets).some(({ source }) => "op" in source)) {
    const version = run("op", ["--version"])
    if (version.status !== 0) fail(`op --version failed:\n${version.stderr.trim()}`)
  }
}

/** Value of one KEY in decrypted dotenv text; quotes around the value are stripped. */
function dotenvValue(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${key}=`)) continue
    const value = line.slice(key.length + 1)
    const quoted = /^(["'])(.*)\1$/.exec(value)
    return quoted ? quoted[2] : value
  }
  return undefined
}

function readValue(name: string, source: Source, repoRoot: string): string {
  let value: string | undefined
  if ("sops" in source) {
    const result = run(join(repoRoot, "scripts/onepassword-secrets.mts"), [
      "show",
      join(repoRoot, source.sops),
    ])
    if (result.status !== 0) fail(`${name}: reading ${source.sops} failed:\n${result.stderr.trim()}`)
    value = dotenvValue(result.stdout.toString("utf8"), source.key)
    if (value === undefined) fail(`${name}: ${source.sops} has no ${source.key}`)
  } else {
    const result = run("op", ["read", "--no-newline", source.op])
    if (result.status !== 0) fail(`${name}: op read failed:\n${result.stderr.trim()}`)
    value = result.stdout.toString("utf8")
  }
  if (value === "") fail(`${name}: value is empty`)
  return value
}

function main(): void {
  let values: Record<string, unknown>
  try {
    values = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        secret: { type: "string" },
        repo: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }).values
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n`)
    usage()
    process.exitCode = 1
    return
  }
  if (values.help) {
    usage()
    return
  }

  const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."))
  const dryRun = values["dry-run"] === true
  try {
    const all = loadConfig(repoRoot)
    const onlySecret = values.secret as string | undefined
    const onlyRepo = values.repo as string | undefined
    if (onlySecret && !all[onlySecret]) fail(`no secret "${onlySecret}" in ${CONFIG_PATH}`)

    const selected: Record<string, SecretConfig> = {}
    for (const [name, config] of Object.entries(all)) {
      if (onlySecret && name !== onlySecret) continue
      const repos = onlyRepo ? config.repos.filter((repo) => repo === onlyRepo) : config.repos
      if (repos.length > 0) selected[name] = { ...config, repos }
    }
    if (Object.keys(selected).length === 0) fail(`no secret is configured for repo "${onlyRepo}"`)

    preflight(selected, repoRoot)

    let failures = 0
    for (const [name, { source, repos, apps }] of Object.entries(selected)) {
      if (dryRun) {
        for (const repo of repos) {
          for (const app of apps) console.log(`would set ${name} on ${repo} (${app})`)
        }
        continue
      }
      const value = readValue(name, source, repoRoot)
      for (const repo of repos) {
        for (const app of apps) {
          const args = ["secret", "set", name, "--repo", repo]
          if (app !== "actions") args.push("--app", app)
          const result = run("gh", args, value)
          if (result.status === 0) {
            console.log(`${OK} ${repo} ${name} (${app})`)
          } else {
            failures++
            console.log(`${BAD} ${repo} ${name} (${app})`)
            note(result.stderr.trim())
          }
        }
      }
    }
    if (failures > 0) fail(`${failures} secret push(es) failed`)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  }
}

function usage(): void {
  console.error(
    [
      "Usage: ./scripts/sync-actions-secrets.mts [--dry-run] [--secret <NAME>] [--repo <owner/name>]",
      "",
      `Sets each secret in ${CONFIG_PATH} on its repos with gh secret set.`,
      "  --dry-run   list what would be set; reads no values",
      "  --secret    only this secret",
      "  --repo      only this repo",
    ].join("\n"),
  )
}

main()

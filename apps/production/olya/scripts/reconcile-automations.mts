#!/usr/bin/env -S node --experimental-strip-types
// Applies the job files in the checkout's automations/ directory to the gateway's job store, and
// removes jobs that were declared there and no longer are. Called by instruction-sync.mts once
// after boot, and again from its 15-minute loop whenever a fetch brings new commits to main;
// runnable by hand the same way.
//
// Each file is the params object for the gateway's cron.add. With a declarationKey, cron.add
// converges instead of creating: an existing job with that key is updated in place and keeps its
// id and run history, and an unchanged declaration is a no-op. That is what makes it safe to run
// this on every pull. A job disabled by hand with `openclaw automations disable <id>` or the
// Control UI, or disabled by OpenClaw itself after repeated failures, stays disabled: a file
// that omits `enabled` leaves it that way, and `enabled: true` turns it back on.
//
// Removal only ever considers jobs whose key starts with DECLARATION_PREFIX. Everything else in
// the store (hand-made reminders, the heartbeat and other plugin-owned jobs) was not created from
// this directory, and this script must never delete it.
//
// It talks to the gateway through `openclaw gateway call` on loopback with the shared token,
// which the gateway treats as a local operator. The CLI gets an empty state dir and a config
// path that does not exist: the live openclaw.json substitutes secrets this container does not
// have, and the call needs nothing from it.
//
// TypeScript run through Node's native type stripping, same as the other scripts here.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { WORKSPACE } from "./volume-layout.mts"

export const DECLARATION_PREFIX = "activeassistant:"

// Overridable so this can be exercised against a throwaway gateway and directory.
const automationsDir = process.env.AUTOMATIONS_DIR ?? join(WORKSPACE, "automations")
const cliStateDir = process.env.RECONCILE_STATE_DIR ?? "/tmp/reconcile-automations"

type Job = { id: string; name: string; declarationKey?: string }
type Declaration = { declarationKey: string; name: string; [field: string]: unknown }

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ==> ${msg}`)
}

function gatewayCall<T>(method: string, params: object): T {
  mkdirSync(cliStateDir, { recursive: true })
  const out = execFileSync(
    "openclaw",
    ["gateway", "call", method, "--json", "--timeout", "30000", "--params", JSON.stringify(params)],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: cliStateDir,
        OPENCLAW_CONFIG_PATH: join(cliStateDir, "no-config.json"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  )
  return JSON.parse(out) as T
}

function readDeclarations(): Declaration[] {
  // Deleting the last file deletes the directory, so a missing directory means nothing is
  // declared and every job with the prefix should go.
  if (!existsSync(automationsDir)) return []

  const declarations: Declaration[] = []
  const seen = new Map<string, string>()
  for (const file of readdirSync(automationsDir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue
    const path = join(automationsDir, file)
    const declaration = JSON.parse(
      execFileSync("yq", ["-o=json", ".", path], { encoding: "utf8" }),
    ) as Declaration
    const key = declaration?.declarationKey
    if (typeof key !== "string" || !key.startsWith(DECLARATION_PREFIX)) {
      throw new Error(`${path}: declarationKey must start with "${DECLARATION_PREFIX}"`)
    }
    if (seen.has(key)) {
      throw new Error(`${path}: declarationKey ${key} is also used by ${seen.get(key)}`)
    }
    seen.set(key, file)
    declarations.push(declaration)
  }
  return declarations
}

function listJobs(): Job[] {
  const jobs: Job[] = []
  let offset = 0
  while (true) {
    const page = gatewayCall<{ jobs: Job[]; hasMore?: boolean; nextOffset?: number }>("cron.list", {
      includeDisabled: true,
      compact: true,
      limit: 200,
      offset,
    })
    jobs.push(...page.jobs)
    if (!page.hasMore || page.nextOffset === undefined) return jobs
    offset = page.nextOffset
  }
}

/** Throws after attempting every file if any of them failed, so the caller retries. */
export function reconcileAutomations(): void {
  // A file that does not parse stops the whole run before anything is applied or removed.
  const declarations = readDeclarations()
  const declared = new Set(declarations.map((d) => d.declarationKey))
  const failures: string[] = []

  for (const declaration of declarations) {
    try {
      const result = gatewayCall<{ created: boolean; updated?: boolean; job: Job }>(
        "cron.add",
        declaration,
      )
      const outcome = result.created ? "created" : result.updated ? "updated" : "unchanged"
      log(`${declaration.declarationKey}: ${outcome} (job ${result.job.id})`)
    } catch (err) {
      failures.push(declaration.declarationKey)
      log(`${declaration.declarationKey}: apply failed: ${(err as Error).message}`)
    }
  }

  for (const job of listJobs()) {
    const key = job.declarationKey
    if (!key?.startsWith(DECLARATION_PREFIX) || declared.has(key)) continue
    try {
      gatewayCall("cron.remove", { id: job.id })
      log(`${key}: removed job ${job.id} (${job.name}), no longer declared`)
    } catch (err) {
      failures.push(key)
      log(`${key}: remove failed: ${(err as Error).message}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`automations not reconciled: ${failures.join(", ")}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reconcileAutomations()
}

#!/usr/bin/env -S node --experimental-strip-types
// Adds a sender, or rotates one, on a public ingest path: Prometheus remote write at
// https://prometheus.activescott.com/api/v1/write, or Loki push at
// https://loki.activescott.com/loki/api/v1/push. Senders are debeth's Alloy
// (activescott/activeassistant#648) and the Dreamwright agents host (ping-poet/dreamwright#122).
//
// Generates a random password, replaces the user's bcrypt htpasswd line in the path's users
// file (keeping every other user's line), re-encrypts the file to the age recipient, and prints
// the password once on stdout, piped straight to the sender. Run it yourself, never through an
// agent: the printed password is the only copy, and the encrypted file holds only hashes.
//
// Usage:
//   ./scripts/add-ingest-user.mts <prometheus-remote-write|loki-push> <user> | ssh <host> 'sudo install -m 0400 /dev/stdin <password file>'
//
// For example, debeth:
//   ./scripts/add-ingest-user.mts prometheus-remote-write debeth | ssh debeth 'sudo install -m 0400 /dev/stdin /mnt/fury4t/eth-docker/alloy/secrets/nas-prometheus-password'
//
// Needs sops, htpasswd (macOS ships /usr/sbin/htpasswd; on Linux, apache2-utils or
// httpd-tools) and the 1Password CLI: reading the other users' lines means decrypting the file,
// which scripts/onepassword-secrets.mts does with the age private key.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The `.public-key-encrypted` marks a secret with no plaintext copy anywhere, so
// scripts/onepassword-secrets.mts does not look for one.
const TARGETS: Record<string, string> = {
  "prometheus-remote-write":
    "apps/production/monitoring/prometheus/prometheus-remote-write-users.public-key-encrypted.encrypted",
  "loki-push": "apps/production/monitoring/loki/loki-push-users.public-key-encrypted.encrypted",
}
// Held debeth's line as a single dotenv value before the remote-write path had a second
// sender. The first run against prometheus-remote-write carries that line over and deletes it.
const LEGACY_REMOTE_WRITE_FILE =
  "apps/production/monitoring/prometheus/.env.secret.prometheus-remote-write-auth.public-key-encrypted.encrypted"
const SOPS_CONFIG = ".sops.yaml"
const ONEPASSWORD_SECRETS = "scripts/onepassword-secrets.mts"
const USER_NAME = /^[a-z0-9][a-z0-9-]*$/
// A placeholder line (a hash too short to be bcrypt) fails this and is dropped.
const BCRYPT_LINE = /^([a-z0-9][a-z0-9-]*):\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/

interface CommandResult {
  status: number
  stdout: Buffer
  stderr: string
}

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message)
}

/** Everything but the password goes to stderr, so stdout carries the password alone. */
function note(message: string): void {
  console.error(message)
}

/** stdout may hold a secret; callers must never log it. Only stderr is surfaced. */
function run(command: string, args: string[], input: string): CommandResult {
  const result = spawnSync(command, args, { input })
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

function configuredRecipient(repoRoot: string): string {
  const path = join(repoRoot, SOPS_CONFIG)
  if (!existsSync(path)) fail(`${SOPS_CONFIG} not found under ${repoRoot}`)
  const text = readFileSync(path, "utf8")
  const matches = [...text.matchAll(/^[ \t]*(?:-[ \t]+)?age:[ \t]*(age1[0-9a-z]+)[ \t]*$/gm)]
  if (matches.length !== 1) {
    fail(`expected exactly one age: recipient in ${SOPS_CONFIG}, found ${matches.length}`)
  }
  return matches[0][1]
}

/** Decrypted contents of a committed file. Callers must not log the result. */
function decrypt(repoRoot: string, file: string): string {
  const shown = run(join(repoRoot, ONEPASSWORD_SECRETS), ["show", join(repoRoot, file)], "")
  if (shown.status !== 0) {
    fail(`${ONEPASSWORD_SECRETS} show ${file} failed:\n${shown.stderr.trim()}`)
  }
  return shown.stdout.toString("utf8")
}

/** The real htpasswd lines in `text`, by user. Placeholders and blank lines are dropped. */
function bcryptLines(text: string): Map<string, string> {
  const lines = new Map<string, string>()
  for (const line of text.split("\n").map((each) => each.trim())) {
    const match = line.match(BCRYPT_LINE)
    if (match) lines.set(match[1], line)
  }
  return lines
}

function main(): void {
  const [targetName, user] = process.argv.slice(2)
  if (process.argv.length !== 4 || !(targetName in TARGETS) || !USER_NAME.test(user)) {
    const targets = Object.keys(TARGETS).join("|")
    console.error(`Usage: ./scripts/add-ingest-user.mts <${targets}> <user>`)
    process.exitCode = 1
    return
  }
  try {
    const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."))
    const recipient = configuredRecipient(repoRoot)
    const secretFile = TARGETS[targetName]
    const target = join(repoRoot, secretFile)

    const lines = bcryptLines(decrypt(repoRoot, secretFile))
    const legacy = join(repoRoot, LEGACY_REMOTE_WRITE_FILE)
    const migrating = targetName === "prometheus-remote-write" && existsSync(legacy)
    if (migrating) {
      // The dotenv file held a single `users=<line>`.
      const legacyText = decrypt(repoRoot, LEGACY_REMOTE_WRITE_FILE).replace(/^users=/m, "")
      for (const [name, line] of bcryptLines(legacyText)) {
        if (!lines.has(name)) lines.set(name, line)
      }
    }

    // Hex, so the value survives copy and paste and has nothing a shell would read.
    const password = randomBytes(32).toString("hex")

    // -i reads the password from stdin, keeping it out of htpasswd's argv. -n prints the line
    // instead of writing a file.
    const hashed = run("htpasswd", ["-niB", user], `${password}\n`)
    if (hashed.status !== 0) fail(`htpasswd failed:\n${hashed.stderr.trim()}`)
    const line = hashed.stdout.toString("utf8").trim()
    if (bcryptLines(line).get(user) !== line) fail("htpasswd did not print a single bcrypt line")
    lines.set(user, line)

    const encrypted = run(
      "sops",
      [
        "encrypt",
        "--age",
        recipient,
        "--input-type",
        "binary",
        "--output-type",
        "binary",
        "--filename-override",
        secretFile.slice(0, -".encrypted".length),
      ],
      `${[...lines.values()].join("\n")}\n`,
    )
    if (encrypted.status !== 0) fail(`sops encrypt failed:\n${encrypted.stderr.trim()}`)

    // Into a temp file beside the target, then renamed, so a failure leaves the old file whole.
    const staging = `${target}.tmp.${process.pid}`
    try {
      writeFileSync(staging, encrypted.stdout, { mode: 0o644 })
      renameSync(staging, target)
    } finally {
      rmSync(staging, { force: true })
    }
    if (migrating) rmSync(legacy)

    note(
      [
        `Wrote ${secretFile} with users: ${[...lines.keys()].join(", ")}`,
        ...(migrating ? [`Deleted ${LEGACY_REMOTE_WRITE_FILE}; its users were carried over.`] : []),
        "",
        "Commit it on a branch and open a PR:",
        `  git add -A ${dirname(secretFile)}`,
        `  git commit -m "Rotate ${user} ingest credential"`,
        "",
        "The password on stdout is never shown: pipe this script straight into the sender",
        "instead of running it bare.",
        "",
        `Rerunning rotates it. Once Flux applies the new file, a password ${user} had before`,
        "stops working. Other users' passwords are unchanged.",
        "",
      ].join("\n"),
    )
    process.stdout.write(`${password}\n`)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  }
}

main()

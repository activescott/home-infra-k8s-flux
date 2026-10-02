#!/usr/bin/env -S node --experimental-strip-types
// Creates or rotates the credential debeth's Alloy uses to push metrics to
// https://prometheus.activescott.com/api/v1/write (activescott/activeassistant#648).
//
// Generates a random password, writes its bcrypt htpasswd line sops-encrypted to the age
// recipient, and prints the password once on stdout, piped straight to debeth. Run it
// yourself, never through an agent: the printed password is the only copy, and the encrypted
// file holds only the hash.
//
// Usage:
//   ./scripts/create-debeth-remote-write-auth.mts | ssh debeth 'sudo install -m 0400 /dev/stdin /mnt/fury4t/eth-docker/alloy/secrets/nas-prometheus-password'
//
// Needs sops and htpasswd (macOS ships /usr/sbin/htpasswd; on Linux, apache2-utils or
// httpd-tools). No private key: encrypting needs only the recipient.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The `.public-key-encrypted` marks a secret with no plaintext copy anywhere, so
// scripts/onepassword-secrets.mts does not look for one.
const SECRET_FILE =
  "apps/production/monitoring/prometheus/.env.secret.prometheus-remote-write-auth.public-key-encrypted.encrypted"
const SOPS_CONFIG_INCLUDE = "scripts/_sops_config.include.sh"
const USER = "debeth"
const DEBETH_PASSWORD_FILE = "/mnt/fury4t/eth-docker/alloy/secrets/nas-prometheus-password"
const BCRYPT_LINE = new RegExp(`^${USER}:\\$2[aby]\\$\\d\\d\\$[./A-Za-z0-9]{53}$`)

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
  const path = join(repoRoot, SOPS_CONFIG_INCLUDE)
  if (!existsSync(path)) fail(`${SOPS_CONFIG_INCLUDE} not found under ${repoRoot}`)
  const match = readFileSync(path, "utf8").match(/^age_key_public="([^"]+)"/m)
  if (!match) fail(`no age_key_public assignment in ${SOPS_CONFIG_INCLUDE}`)
  return match[1]
}

function main(): void {
  if (process.argv.length > 2) {
    console.error("Usage: ./scripts/create-debeth-remote-write-auth.mts")
    process.exitCode = 1
    return
  }
  try {
    const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."))
    const recipient = configuredRecipient(repoRoot)
    const target = join(repoRoot, SECRET_FILE)

    // Hex, so the value survives copy and paste and has nothing a shell or dotenv would read.
    const password = randomBytes(32).toString("hex")

    // -i reads the password from stdin, keeping it out of htpasswd's argv. -n prints the line
    // instead of writing a file.
    const hashed = run("htpasswd", ["-niB", USER], `${password}\n`)
    if (hashed.status !== 0) fail(`htpasswd failed:\n${hashed.stderr.trim()}`)
    const line = hashed.stdout.toString("utf8").trim()
    if (!BCRYPT_LINE.test(line)) fail("htpasswd did not print a single bcrypt line")

    const encrypted = run(
      "sops",
      [
        "encrypt",
        "--age",
        recipient,
        "--input-type",
        "dotenv",
        "--output-type",
        "dotenv",
        "--filename-override",
        SECRET_FILE.slice(0, -".encrypted".length),
      ],
      `users=${line}\n`,
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

    note(
      [
        `Wrote ${SECRET_FILE}`,
        "",
        "Commit it on a branch and open a PR:",
        `  git add ${SECRET_FILE}`,
        '  git commit -m "Rotate debeth remote-write credential"',
        "",
        "The password on stdout is never shown: pipe this script straight into debeth instead",
        "of running it bare:",
        `  ./scripts/create-debeth-remote-write-auth.mts | ssh debeth 'sudo install -m 0400 /dev/stdin ${DEBETH_PASSWORD_FILE}'`,
        "",
        "Rerunning rotates it. Once Flux applies the new file, a password debeth had before",
        "stops working.",
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

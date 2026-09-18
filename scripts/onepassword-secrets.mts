#!/usr/bin/env -S node --experimental-strip-types
// Backs the repo's plaintext secrets up to 1Password, and pulls them back.
//
// Every secret here exists twice: a SOPS+age ciphertext (`*.encrypted`, committed,
// consumed by Flux) and the plaintext original (gitignored, local-only). This moves
// that plaintext to a 1Password item per directory, named
// "home-infra-kubernetes secrets <group>", with one file attachment per secret file.
//
// Usage:
//   ./scripts/onepassword-secrets.mts list [--offline]
//   ./scripts/onepassword-secrets.mts push [--only <path|group>]... [--dry-run] [--delete-after-push]
//   ./scripts/onepassword-secrets.mts pull <dir|group> [--force] [--out <dir>]
//
// Global flags: --vault <name> (default Private, or $OP_VAULT), --repo-root <path>

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

// Matches the items created by hand before this script existed, e.g.
// "home-infra kubernetes secrets authelia". LEGACY_ITEM_TITLE is the older monolithic
// item that held every app's files in one note, one section per app; it is superseded
// by the per-directory items but never touched by this script.
const ITEM_TITLE_PREFIX = "home-infra kubernetes secrets "
const LEGACY_ITEM_TITLE = "home-infra kubernetes secrets"
const ITEM_TAG = "home-infra-k8s-flux"
const ITEM_CATEGORY = "Secure Note"
const REPO_PATH_FIELD = "repo_path"
const DEFAULT_VAULT = process.env.OP_VAULT ?? "Private"
const AGE_KEY_FILENAME = "home-infra-private.agekey"

// All three are surrogate pairs: same UTF-16 length and same terminal width, so padding
// a status column stays aligned whichever one is used. Single-code-unit marks like ✅
// count as 1 but render as 2 columns, which skews every line after them.
const OK = "🟢"
const WARN = "🟡"
const BAD = "🔴"

const EXCLUDED_DIRS = new Set([".git", "node_modules"])
const EXCLUDED_SUFFIXES = [".encrypted", ".example", ".template"]

// `.env.secret.<name>.public-key-encrypted.encrypted` is a machine-to-machine token generated
// by a create-*.sh script and encrypted straight to the age recipient: no plaintext original
// ever exists, on this disk or any other. Those are listed, so the inventory stays complete,
// but never pushed, and 1Password never holds an attachment for one, which is what keeps pull
// from expecting it too.
const PUBLIC_KEY_ENCRYPTED_SUFFIX = ".public-key-encrypted"

// A plaintext file with no ciphertext sibling is still a secret worth backing up
// (the bootstrap creds under scripts/, the crossplane cloudflare tokens, the age key).
const ORPHAN_PATTERNS = [
  /^\.env\.secret/,
  /\.secret$/,
  /\.agekey$/,
  /\.dockeronfigjson$/,
  /credentials\.json$/,
]

// The generic rule (strip deploy-tier prefix, drop structural segments, join with "-")
// produces an awkward name for a handful of directories. Naming those explicitly beats
// inventing a cleverer rule.
const GROUP_OVERRIDES: Record<string, string> = {
  ".": "sops-age-key",
  "apps/base/photoprism": "photoprism-base",
  "apps/production/github-runners/runners/fernfiles": "github-runners-fernfiles",
  "apps/production/github-runners/runners/ramblefeed": "github-runners-ramblefeed",
  "apps/production/github-runners/runners/tinkerbell": "github-runners-tinkerbell",
}
const STRIP_PREFIXES = [
  "apps/production/",
  "apps/base/",
  "infrastructure/prod/",
  "infrastructure/base/",
]
const DROP_SEGMENTS = new Set(["configs", "controllers"])

interface SecretFile {
  /** repo-relative path of the plaintext file */
  relPath: string
  /** repo-relative directory holding it ("." for repo root) */
  relDir: string
  /** basename; doubles as the 1Password file attachment name */
  label: string
  /** absolute path of the plaintext file (may not exist when needsDecrypt) */
  absPath: string
  /** plaintext is absent locally and must be sops-decrypted from absPath + ".encrypted" */
  needsDecrypt: boolean
  /** no plaintext exists by design; see PUBLIC_KEY_ENCRYPTED_SUFFIX */
  publicKeyEncrypted: boolean
}

interface SecretGroup {
  name: string
  relDir: string
  title: string
  files: SecretFile[]
}

interface OpFile {
  id: string
  name: string
  size?: number
}

interface OpItem {
  id: string
  title: string
  category?: string
  files?: OpFile[]
  fields?: { id?: string; label?: string; value?: string }[]
}

interface CommandResult {
  status: number
  stdout: Buffer
  stderr: string
}

interface PushEntry {
  file: SecretFile
  /** absolute path of the plaintext to upload — the real file, or a decrypted temp copy */
  sourcePath: string
  localHash: string
  status: "new" | "changed" | "unchanged"
  /** matched 1Password only after blank lines were ignored on both sides */
  matchedIgnoringBlankLines?: boolean
}

/** Thrown instead of calling process.exit so temp-file cleanup in `finally` still runs. */
class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message)
}

/**
 * Runs a command capturing stdout as a Buffer. stdout may hold plaintext secrets, so
 * callers must never log it; only stderr is ever surfaced.
 */
function run(command: string, args: string[], env?: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, {
    env: env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
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

function op(args: string[]): CommandResult {
  return run("op", args)
}

function opJson<T>(args: string[]): T {
  const result = op([...args, "--format", "json"])
  if (result.status !== 0) {
    fail(`op ${args.join(" ")} failed:\n${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout.toString())
}

const SIGNIN_HELP = [
  "1Password CLI is not connected. Fix one of:",
  "  - turn on the desktop app integration (1Password > Settings > Developer >",
  "    'Integrate with 1Password CLI'), then run `op signin`",
  "  - or export OP_SERVICE_ACCOUNT_TOKEN=<service account token>",
].join("\n")

/**
 * Verifies `op` is installed, has an account, and can actually reach the target vault.
 * The vault check is the real one: the first two pass while the CLI is locked.
 */
function preflight(vault: string): void {
  const version = op(["--version"])
  if (version.status !== 0) {
    fail(`op --version failed:\n${version.stderr.trim()}\n\n${SIGNIN_HELP}`)
  }

  const accounts = op(["account", "list", "--format", "json"])
  if (accounts.status !== 0) {
    fail(`${accounts.stderr.trim()}\n\n${SIGNIN_HELP}`)
  }
  const parsed: unknown = JSON.parse(accounts.stdout.toString() || "[]")
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail(`op has no accounts configured.\n\n${SIGNIN_HELP}`)
  }

  const vaultCheck = op(["vault", "get", vault, "--format", "json"])
  if (vaultCheck.status !== 0) {
    fail(
      `cannot read vault "${vault}":\n${vaultCheck.stderr.trim()}\n\n` +
        `The vault may not exist, or the CLI is locked.\n${SIGNIN_HELP}`,
    )
  }
  console.log(`op connected; vault "${vault}" reachable`)
}

function requireSops(repoRoot: string): string {
  const version = run("sops", ["--version"])
  if (version.status !== 0) {
    fail(`sops --version failed:\n${version.stderr.trim()}`)
  }
  // An already-exported SOPS_AGE_KEY_FILE wins, so the key can live outside the tree being
  // scanned — otherwise testing against a scratch repo would mean copying the private key
  // into it.
  const fromEnv = process.env.SOPS_AGE_KEY_FILE
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      fail(`SOPS_AGE_KEY_FILE points at ${fromEnv}, which does not exist`)
    }
    return fromEnv
  }
  const ageKeyPath = join(repoRoot, AGE_KEY_FILENAME)
  if (!existsSync(ageKeyPath)) {
    fail(
      `age key not found at ${ageKeyPath} and SOPS_AGE_KEY_FILE is unset; one is required ` +
        `to decrypt secrets whose plaintext is missing locally`,
    )
  }
  return ageKeyPath
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function isExcluded(label: string): boolean {
  return EXCLUDED_SUFFIXES.some((suffix) => label.endsWith(suffix))
}

function isOrphanCandidate(label: string): boolean {
  return ORPHAN_PATTERNS.some((pattern) => pattern.test(label))
}

function trackedFiles(repoRoot: string): Set<string> {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) {
    fail(`git ls-files failed:\n${(result.stderr ?? Buffer.alloc(0)).toString().trim()}`)
  }
  return new Set(result.stdout.toString().split("\0").filter(Boolean))
}

function discover(repoRoot: string): SecretGroup[] {
  const tracked = trackedFiles(repoRoot)
  const candidates = new Map<string, SecretFile>()

  function addCandidate(relPath: string, needsDecrypt: boolean): void {
    const label = basename(relPath)
    if (isExcluded(label)) return
    // A plaintext secret in git is a bug, not something to quietly back up. The one
    // current hit is the committed Home Assistant secrets.yaml placeholder stub.
    if (tracked.has(relPath)) return
    const existing = candidates.get(relPath)
    if (existing) {
      if (!needsDecrypt) existing.needsDecrypt = false
      return
    }
    candidates.set(relPath, {
      relPath,
      relDir: dirname(relPath),
      label,
      absPath: join(repoRoot, relPath),
      needsDecrypt,
      publicKeyEncrypted: label.endsWith(PUBLIC_KEY_ENCRYPTED_SUFFIX),
    })
  }

  for (const abs of walk(repoRoot)) {
    const relPath = relative(repoRoot, abs)
    const label = basename(relPath)
    if (label.endsWith(".encrypted")) {
      const plain = relPath.slice(0, -".encrypted".length)
      addCandidate(plain, !existsSync(join(repoRoot, plain)))
    } else if (isOrphanCandidate(label)) {
      addCandidate(relPath, false)
    }
  }

  const byGroup = new Map<string, SecretGroup>()
  const groupSource = new Map<string, string>()
  const sorted = [...candidates.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))
  for (const file of sorted) {
    const name = groupFor(file.relDir)
    const claimedBy = groupSource.get(name)
    if (claimedBy !== undefined && claimedBy !== file.relDir) {
      fail(
        `group name collision: "${claimedBy}" and "${file.relDir}" both map to "${name}". ` +
          `Add an entry to GROUP_OVERRIDES.`,
      )
    }
    groupSource.set(name, file.relDir)
    const existing = byGroup.get(name)
    if (existing) {
      existing.files.push(file)
    } else {
      byGroup.set(name, {
        name,
        relDir: file.relDir,
        title: ITEM_TITLE_PREFIX + name,
        files: [file],
      })
    }
  }
  return [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function groupFor(relDir: string): string {
  const override = GROUP_OVERRIDES[relDir]
  if (override) return override
  let rest = relDir
  for (const prefix of STRIP_PREFIXES) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length)
      break
    }
  }
  const segments = rest.split("/").filter((segment) => segment && !DROP_SEGMENTS.has(segment))
  if (segments.length === 0) {
    fail(`cannot derive a group name for directory "${relDir}"; add it to GROUP_OVERRIDES`)
  }
  return segments.join("-")
}

/**
 * Escapes a field name for an `op` assignment statement. Periods separate section from
 * field there, so a label like `.env.secret.app` is otherwise read as nested sections.
 */
function escapeFieldName(name: string): string {
  if (name.includes("[") || name.includes("]")) {
    fail(`file name "${name}" contains [ or ], which op assignment statements cannot express`)
  }
  // An assignment is a bare argv token, so a leading dash is parsed by op as a flag. No
  // shell is involved, so this is argument injection rather than command injection, but a
  // repo file named "-foo" would still reach op's flag parser.
  if (name.startsWith("-")) {
    fail(`file name "${name}" starts with "-", which op would parse as a flag`)
  }
  return name.replace(/([\\.=])/g, "\\$1")
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function sha256File(path: string): string {
  return sha256(readFileSync(path))
}

/**
 * Drops blank lines. A sops dotenv round-trip is byte-identical to the original except
 * that blank lines are discarded — comments, quoting and values all survive. Once a file's
 * local plaintext is deleted, the only thing left to compare against 1Password is that
 * round-trip, so without this every dotenv file that had a blank line reports `changed`
 * forever and each push overwrites the pristine stored original with the reconstruction.
 */
function stripBlankLines(bytes: Buffer): Buffer {
  const kept = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
  return Buffer.from(kept.join("\n"), "utf8")
}

interface ContentHashes {
  /** sha256 of the bytes as-is */
  raw: string
  /** sha256 with blank lines removed, for comparing against a sops dotenv round-trip */
  normalized: string
}

function hashesOf(bytes: Buffer): ContentHashes {
  return { raw: sha256(bytes), normalized: sha256(stripBlankLines(bytes)) }
}

function sopsFormat(encryptedPath: string, label: string): "dotenv" | "binary" | "json" {
  if (label.startsWith(".env") || label.startsWith("env.")) return "dotenv"
  const text = readFileSync(encryptedPath, "utf8")
  if (!text.trimStart().startsWith("{")) return "dotenv"
  const parsed: Record<string, unknown> = JSON.parse(text)
  const keys = Object.keys(parsed).filter((key) => key !== "sops")
  return keys.length === 1 && keys[0] === "data" ? "binary" : "json"
}

/** Decrypts to `outPath` and reports which sops format was used. */
function decryptTo(
  file: SecretFile,
  outPath: string,
  ageKeyPath: string,
): "dotenv" | "binary" | "json" {
  const encryptedPath = `${file.absPath}.encrypted`
  const format = sopsFormat(encryptedPath, file.label)
  const result = run(
    "sops",
    ["decrypt", "--input-type", format, "--output-type", format, encryptedPath],
    { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath },
  )
  if (result.status !== 0) {
    fail(`sops decrypt failed for ${file.relPath}.encrypted:\n${result.stderr.trim()}`)
  }
  writeFileSync(outPath, result.stdout, { mode: 0o600 })
  return format
}

function listItemsByTitle(vault: string): Map<string, string> {
  const items = opJson<{ id: string; title: string }[]>(["item", "list", "--vault", vault])
  const map = new Map<string, string>()
  for (const item of items) {
    if (item.title.startsWith(ITEM_TITLE_PREFIX)) map.set(item.title, item.id)
    if (item.title === LEGACY_ITEM_TITLE) {
      console.log(`Note: legacy item "${LEGACY_ITEM_TITLE}" present; never read or written here.`)
    }
  }
  return map
}

function getItem(itemId: string, vault: string): OpItem {
  return opJson<OpItem>(["item", "get", itemId, "--vault", vault])
}

function attachmentFor(item: OpItem, label: string): OpFile | undefined {
  return (item.files ?? []).find((file) => file.name === label)
}

/**
 * Downloads an attachment to `outPath`, returns its hashes, and always removes outPath —
 * a second plaintext copy on disk must not outlive the comparison it exists for.
 */
function hashAttachment(
  vault: string,
  itemId: string,
  label: string,
  outPath: string,
): ContentHashes {
  try {
    const result = op(["read", "--out-file", outPath, `op://${vault}/${itemId}/${label}`])
    if (result.status !== 0) {
      fail(`op read of "${label}" from item ${itemId} failed:\n${result.stderr.trim()}`)
    }
    chmodSync(outPath, 0o600)
    return hashesOf(readFileSync(outPath))
  } finally {
    if (existsSync(outPath)) unlinkSync(outPath)
  }
}

function editItem(itemId: string, vault: string, assignments: string[]): void {
  const result = op(["item", "edit", itemId, "--vault", vault, ...assignments])
  if (result.status !== 0) {
    fail(`op item edit ${itemId} failed:\n${result.stderr.trim()}`)
  }
}

/**
 * Attaches (or replaces) a file on an item, then verifies exactly one attachment carries
 * that name. If re-assigning appended a second copy instead of replacing, deletes the
 * field and re-adds it.
 */
function attachFile(itemId: string, vault: string, label: string, sourcePath: string): OpItem {
  const escaped = escapeFieldName(label)
  editItem(itemId, vault, [`${escaped}[file]=${sourcePath}`])
  let item = getItem(itemId, vault)
  let matches = (item.files ?? []).filter((file) => file.name === label)
  if (matches.length > 1) {
    editItem(itemId, vault, [`${escaped}[delete]=`])
    editItem(itemId, vault, [`${escaped}[file]=${sourcePath}`])
    item = getItem(itemId, vault)
    matches = (item.files ?? []).filter((file) => file.name === label)
  }
  if (matches.length !== 1) {
    fail(
      `after attaching "${label}" to item ${itemId}, found ${matches.length} attachments ` +
        `with that name; fix the item by hand before re-running`,
    )
  }
  return item
}

function createItem(group: SecretGroup, vault: string, entries: PushEntry[]): OpItem {
  const assignments = [`${REPO_PATH_FIELD}[text]=${group.relDir}`]
  for (const entry of entries) {
    assignments.push(`${escapeFieldName(entry.file.label)}[file]=${entry.sourcePath}`)
  }
  const result = op([
    "item",
    "create",
    "--category",
    ITEM_CATEGORY,
    "--vault",
    vault,
    "--title",
    group.title,
    "--tags",
    ITEM_TAG,
    ...assignments,
    "--format",
    "json",
  ])
  if (result.status !== 0) {
    fail(`op item create "${group.title}" failed:\n${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout.toString())
}

function ensureRepoPathField(item: OpItem, vault: string, relDir: string): void {
  const current = (item.fields ?? []).find(
    (field) => field.label === REPO_PATH_FIELD || field.id === REPO_PATH_FIELD,
  )
  if (current?.value === relDir) return
  editItem(item.id, vault, [`${REPO_PATH_FIELD}[text]=${relDir}`])
}

function matchesFilter(group: SecretGroup, file: SecretFile, filters: string[]): boolean {
  if (filters.length === 0) return true
  return filters.some((raw) => {
    const filter = raw.replace(/\/+$/, "")
    return (
      filter === group.name ||
      filter === group.title ||
      filter === file.relPath ||
      file.relDir === filter ||
      file.relDir.startsWith(`${filter}/`)
    )
  })
}

function selectGroups(groups: SecretGroup[], filters: string[]): SecretGroup[] {
  if (filters.length === 0) return groups
  const selected: SecretGroup[] = []
  for (const group of groups) {
    const files = group.files.filter((file) => matchesFilter(group, file, filters))
    if (files.length > 0) selected.push({ ...group, files })
  }
  if (selected.length === 0) {
    fail(`no secrets matched: ${filters.join(", ")}`)
  }
  return selected
}

interface Options {
  vault: string
  repoRoot: string
  dryRun: boolean
  force: boolean
  offline: boolean
  only: string[]
  out?: string
  deleteAfterPush: boolean
  deleteAgeKey: boolean
}

function commandList(options: Options): void {
  if (!options.offline) preflight(options.vault)
  const groups = selectGroups(discover(options.repoRoot), options.only)
  const titles = options.offline ? new Map<string, string>() : listItemsByTitle(options.vault)

  // Column widths come from what is actually being printed, so a --only run of one short
  // group doesn't inherit the whole repo's longest name.
  const titleWidth = Math.max(...groups.map((group) => group.title.length))
  const dirWidth = Math.max(...groups.map((group) => group.relDir.length + 2))
  const labelWidth = Math.max(
    ...groups.flatMap((group) => group.files.map((file) => file.label.length)),
  )

  let fileCount = 0
  let decryptCount = 0
  let publicKeyCount = 0
  let missingCount = 0
  for (const group of groups) {
    const itemId = titles.get(group.title)
    const item = itemId ? getItem(itemId, options.vault) : undefined
    const itemState = options.offline ? "" : `  ${item ? "item exists" : "NO ITEM"}`
    const dirColumn = `[${group.relDir}]`.padEnd(dirWidth)
    console.log(`\n${group.title.padEnd(titleWidth)}  ${dirColumn}${itemState}`.trimEnd())
    for (const file of group.files) {
      fileCount += 1
      if (file.publicKeyEncrypted) publicKeyCount += 1
      else if (file.needsDecrypt) decryptCount += 1
      const source = file.publicKeyEncrypted
        ? "public-key encrypted, no plaintext"
        : file.needsDecrypt
          ? "sops-decrypt"
          : "local plaintext"
      const attachment = item ? attachmentFor(item, file.label) : undefined
      if (!options.offline && !attachment && !file.publicKeyEncrypted) missingCount += 1
      // A public-key-encrypted file has nothing to be attached, so neither "attached" nor
      // "missing" is true of it; "n/a" keeps it out of the count it would otherwise inflate.
      const attached = options.offline
        ? ""
        : file.publicKeyEncrypted
          ? `${OK} n/a `.padEnd(13)
          : `${attachment ? OK : WARN} ${attachment ? "attached" : "missing"} `.padEnd(13)
      console.log(`  ${attached}${file.label.padEnd(labelWidth)}  ${source}`)
    }
  }
  console.log(
    `\n${fileCount} secret file(s) in ${groups.length} group(s); ` +
      `${decryptCount} need sops decryption (no local plaintext)` +
      (publicKeyCount > 0 ? `; ${publicKeyCount} public-key encrypted, nothing to back up` : ""),
  )
  if (!options.offline) {
    console.log(
      missingCount === 0
        ? `${OK} every file is backed up in 1Password ${options.vault} vault`
        : `${WARN} ${missingCount} file(s) not yet in 1Password ${options.vault} vault — run push`,
    )
  }
}

/** True when --delete-after-push is allowed to remove this file's local plaintext. */
function deletable(file: SecretFile, options: Options): boolean {
  if (file.label.endsWith(".agekey")) return options.deleteAgeKey
  return true
}

function classify(
  group: SecretGroup,
  item: OpItem | undefined,
  options: Options,
  tmpRoot: string,
  ageKeyPath: string,
): PushEntry[] {
  const entries: PushEntry[] = []
  for (const file of group.files) {
    let sourcePath = file.absPath
    let decryptFormat: "dotenv" | "binary" | "json" | undefined
    if (file.needsDecrypt) {
      sourcePath = join(tmpRoot, `decrypted-${group.name}-${file.label}`)
      decryptFormat = decryptTo(file, sourcePath, ageKeyPath)
    } else if (!existsSync(sourcePath)) {
      fail(`${file.relPath} disappeared mid-run`)
    }
    const local = hashesOf(readFileSync(sourcePath))

    const attached = item ? attachmentFor(item, file.label) : undefined
    if (!item || !attached) {
      entries.push({ file, sourcePath, localHash: local.raw, status: "new" })
      continue
    }
    const remote = hashAttachment(
      options.vault,
      item.id,
      file.label,
      join(tmpRoot, `readback-${group.name}-${file.label}`),
    )
    // The blank-line tolerance is only sound when the local side came out of sops as
    // dotenv. For a real local plaintext, or a binary/json decrypt, a byte difference is
    // a real difference and must still count as changed.
    const blankLinesOnly =
      decryptFormat === "dotenv" &&
      remote.raw !== local.raw &&
      remote.normalized === local.normalized
    entries.push({
      file,
      sourcePath,
      localHash: local.raw,
      status: remote.raw === local.raw || blankLinesOnly ? "unchanged" : "changed",
      matchedIgnoringBlankLines: blankLinesOnly,
    })
  }
  return entries
}

function commandPush(options: Options, tmpRoot: string): void {
  preflight(options.vault)
  const groups = selectGroups(discover(options.repoRoot), options.only)
  const needsSops = groups.some((group) =>
    group.files.some((file) => file.needsDecrypt && !file.publicKeyEncrypted),
  )
  const ageKeyPath = needsSops ? requireSops(options.repoRoot) : ""
  const titles = listItemsByTitle(options.vault)

  const counts = { unchanged: 0, changed: 0, uploaded: 0, deleted: 0, blankLineOnly: 0, skipped: 0 }
  const wouldDelete: string[] = []

  for (const group of groups) {
    pushGroup(group, options, tmpRoot, ageKeyPath, titles, counts, wouldDelete)
  }

  const skippedNote =
    counts.skipped > 0 ? `, ${counts.skipped} skipped (public-key encrypted, no plaintext)` : ""

  if (options.dryRun) {
    console.log(
      `\nDRY RUN: ${counts.uploaded} to upload, ${counts.changed} to replace, ` +
        `${counts.unchanged} already current${skippedNote}`,
    )
    if (options.deleteAfterPush) {
      console.log(`\nwould delete ${wouldDelete.length} local plaintext file(s):`)
      for (const path of wouldDelete) console.log(`  ${path}`)
    }
    return
  }
  console.log(
    `\n${counts.uploaded} uploaded, ${counts.changed} replaced, ${counts.unchanged} unchanged` +
      skippedNote +
      (options.deleteAfterPush ? `, ${counts.deleted} local plaintext file(s) deleted` : ""),
  )
  if (counts.blankLineOnly > 0) {
    console.log(
      `${counts.blankLineOnly} of those matched only after ignoring blank lines — their ` +
        `local plaintext is gone, so they were compared against a sops dotenv round-trip, ` +
        `which drops blank lines. 1Password keeps the original.`,
    )
  }
}

interface PushCounts {
  unchanged: number
  changed: number
  uploaded: number
  deleted: number
  blankLineOnly: number
  skipped: number
}

/**
 * Handles one group. Split out of commandPush so the decrypted temp files it creates can be
 * unlinked in a `finally` as soon as the group is done, rather than accumulating in tmpRoot
 * for the whole run — a process killed by a signal runs no cleanup at all, so the fewer
 * plaintext copies sitting there at any moment, the better.
 */
function pushGroup(
  group: SecretGroup,
  options: Options,
  tmpRoot: string,
  ageKeyPath: string,
  titles: Map<string, string>,
  counts: PushCounts,
  wouldDelete: string[],
): void {
  const itemId = titles.get(group.title)
  let item = itemId ? getItem(itemId, options.vault) : undefined
  const skipped = group.files.filter((file) => file.publicKeyEncrypted)
  const entries = classify(
    { ...group, files: group.files.filter((file) => !file.publicKeyEncrypted) },
    item,
    options,
    tmpRoot,
    ageKeyPath,
  )
  try {
    console.log(`\n${group.title}  [${group.relDir}]`)
    for (const file of skipped) {
      counts.skipped += 1
      console.log(`  ${OK} skipped   ${file.label} (public-key encrypted, no plaintext)`)
    }
    for (const entry of entries) {
      const mark = entry.status === "unchanged" ? OK : WARN
      const note = entry.matchedIgnoringBlankLines ? "  (matched ignoring blank lines)" : ""
      console.log(`  ${mark} ${entry.status.padEnd(9)} ${entry.file.label}${note}`)
    }

    for (const entry of entries) {
      if (entry.status === "unchanged") counts.unchanged += 1
      else if (entry.status === "changed") counts.changed += 1
      else counts.uploaded += 1
      if (entry.matchedIgnoringBlankLines) counts.blankLineOnly += 1
    }

    if (options.dryRun) {
      for (const entry of entries) {
        if (options.deleteAfterPush && !entry.file.needsDecrypt && deletable(entry.file, options)) {
          wouldDelete.push(entry.file.relPath)
        }
      }
      return
    }

    // A group of nothing but public-key-encrypted files has no plaintext to back up, so it
    // gets no 1Password item at all rather than an empty one.
    if (entries.length === 0) return

    if (!item) {
      item = createItem(group, options.vault, entries)
    } else {
      ensureRepoPathField(item, options.vault, group.relDir)
      for (const entry of entries) {
        if (entry.status === "unchanged") continue
        item = attachFile(item.id, options.vault, entry.file.label, entry.sourcePath)
      }
    }

    if (!options.deleteAfterPush) return
    for (const entry of entries) {
      // Nothing local to delete: the plaintext only ever existed as a temp decrypt.
      if (entry.file.needsDecrypt) continue
      if (!deletable(entry.file, options)) {
        console.log(`  ${WARN} kept      ${entry.file.label} (age key; needs --delete-age-key)`)
        continue
      }
      // Exit code 0 is not proof the bytes landed; the read-back hash is. Compare the raw
      // hash, never the normalized one — the blank-line tolerance must not decide a delete.
      const remote = hashAttachment(
        options.vault,
        item.id,
        entry.file.label,
        join(tmpRoot, `verify-${group.name}-${entry.file.label}`),
      )
      if (remote.raw !== entry.localHash) {
        console.error(`  ${BAD} KEPT      ${entry.file.label} (read-back hash mismatch; not deleting)`)
        continue
      }
      // Re-hash immediately before unlinking: the local file was hashed back in classify(),
      // and an edit made since then was never uploaded and would be destroyed silently.
      if (sha256File(entry.file.absPath) !== entry.localHash) {
        console.error(`  ${BAD} KEPT      ${entry.file.label} (changed on disk during this run)`)
        continue
      }
      unlinkSync(entry.file.absPath)
      counts.deleted += 1
      console.log(`  ${OK} deleted   ${entry.file.relPath}`)
    }
  } finally {
    for (const entry of entries) {
      if (entry.file.needsDecrypt && existsSync(entry.sourcePath)) unlinkSync(entry.sourcePath)
    }
  }
}

function repoPathOf(item: OpItem): string | undefined {
  return (item.fields ?? []).find(
    (field) => field.label === REPO_PATH_FIELD || field.id === REPO_PATH_FIELD,
  )?.value
}

/**
 * Resolves a pull target against 1Password rather than the working tree. Local discovery
 * cannot be the source of truth here: --delete-after-push removes the plaintext, and for
 * a secret with no ciphertext sibling that leaves nothing on disk to discover — so a
 * disk-driven pull would refuse to restore exactly the files that need restoring.
 */
function resolvePullTarget(vault: string, target: string): { item: OpItem; repoPath: string } {
  const normalized = target.replace(/\/+$/, "")
  const items = opJson<{ id: string; title: string }[]>(["item", "list", "--vault", vault]).filter(
    (item) => item.title.startsWith(ITEM_TITLE_PREFIX),
  )

  const byName = items.find(
    (item) => item.title === normalized || item.title.slice(ITEM_TITLE_PREFIX.length) === normalized,
  )
  const candidates = byName ? [byName] : items
  for (const candidate of candidates) {
    const item = getItem(candidate.id, vault)
    const repoPath = repoPathOf(item)
    if (byName) {
      if (!repoPath) {
        fail(
          `item "${item.title}" has no ${REPO_PATH_FIELD} field; run a push first, or use ` +
            `--out to choose a destination directory`,
        )
      }
      return { item, repoPath }
    }
    if (repoPath === normalized) return { item, repoPath }
  }
  fail(
    `no 1Password item in vault ${vault} matches "${target}" by group name or ${REPO_PATH_FIELD}`,
  )
}

/**
 * Both of these come out of the 1Password item, not out of this repo, so neither is
 * trusted. An item edited in the 1Password UI — a `repo_path` of `../../..`, an attachment
 * renamed to contain a slash — would otherwise let `pull` write plaintext to an arbitrary
 * path outside the destination directory.
 */
function assertSafeDestination(baseDir: string, repoPath: string, names: string[]): void {
  const resolvedBase = resolve(baseDir)
  const resolvedDir = resolve(resolvedBase, repoPath)
  if (resolvedDir !== resolvedBase && !resolvedDir.startsWith(`${resolvedBase}/`)) {
    fail(`${REPO_PATH_FIELD} "${repoPath}" resolves outside ${resolvedBase}; refusing to write`)
  }
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      fail(`attachment name "${name}" is not a plain file name; refusing to write`)
    }
  }
}

/**
 * Refuses to write a plaintext secret to a path git would track. This repo is public, so a
 * pull landing outside the gitignore patterns is one `git add .` away from publishing a
 * secret. Today every destination is ignored, but that is convention spread across several
 * .gitignore files rather than anything enforced.
 */
function assertGitIgnored(repoRoot: string, destPaths: string[]): void {
  if (destPaths.length === 0) return
  const result = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: repoRoot,
    input: `${destPaths.join("\n")}\n`,
    maxBuffer: 4 * 1024 * 1024,
  })
  const ignored = new Set(result.stdout.toString().split("\n").filter(Boolean))
  const tracked = destPaths.filter((path) => !ignored.has(path))
  if (tracked.length > 0) {
    fail(
      `git does not ignore these destinations, so pulling would put plaintext secrets in a ` +
        `committable path:\n  ${tracked.join("\n  ")}\n` +
        `Fix .gitignore, or pull to a scratch directory with --out.`,
    )
  }
}

function commandPull(options: Options, target: string, tmpRoot: string): void {
  preflight(options.vault)
  const { item, repoPath } = resolvePullTarget(options.vault, target)
  const attachments = item.files ?? []

  const baseDir = options.out ? resolve(options.out) : options.repoRoot
  assertSafeDestination(
    baseDir,
    repoPath,
    attachments.map((attachment) => attachment.name),
  )

  let written = 0
  let skipped = 0
  const destDir = join(baseDir, repoPath)
  // Only meaningful when writing into the repo; --out points somewhere else entirely.
  if (!options.out) {
    assertGitIgnored(
      options.repoRoot,
      attachments.map((attachment) => join(repoPath, attachment.name)),
    )
  }
  mkdirSync(destDir, { recursive: true })

  console.log(`\n${item.title} -> ${destDir}`)
  for (const attachment of attachments) {
    const destPath = join(destDir, attachment.name)
    if (existsSync(destPath) && !options.force) {
      console.log(`  skipped   ${attachment.name} (exists; use --force to overwrite)`)
      skipped += 1
      continue
    }
    const staging = join(tmpRoot, `pull-${attachment.id}`)
    try {
      const result = op([
        "read",
        "--out-file",
        staging,
        `op://${options.vault}/${item.id}/${attachment.name}`,
      ])
      if (result.status !== 0) {
        fail(`op read of "${attachment.name}" failed:\n${result.stderr.trim()}`)
      }
      // copyFileSync creates the destination with the SOURCE file's mode, and op chose
      // staging's mode. Tighten staging first so the destination is never briefly readable
      // in a 0755 repo directory; chmod after the copy would leave exactly that window.
      chmodSync(staging, 0o600)
      copyFileSync(staging, destPath)
      chmodSync(destPath, 0o600)
    } finally {
      if (existsSync(staging)) unlinkSync(staging)
    }
    console.log(`  wrote     ${attachment.name}`)
    written += 1
  }
  console.log(`\n${written} file(s) written, ${skipped} skipped`)
}

function usage(): void {
  console.log(
    [
      "onepassword-secrets.mts — mirror this repo's plaintext secrets to 1Password.",
      "",
      "Each directory holding secrets maps to one Secure Note titled",
      `"${ITEM_TITLE_PREFIX}<group>", with one file attachment per secret`,
      `file and a ${REPO_PATH_FIELD} field naming the directory. Files are matched by`,
      "sha256, so re-running a command that has nothing to do writes nothing.",
      "",
      "A `.public-key-encrypted.encrypted` file was generated and encrypted straight to the",
      "age recipient and never had a plaintext original, so there is nothing to back up. It",
      "is listed for completeness and skipped by push.",
      "",
      "Usage:",
      "  onepassword-secrets.mts list [--offline] [--only <path|group>]...",
      "  onepassword-secrets.mts push [--only <path|group>]... [--dry-run]",
      "                               [--delete-after-push [--delete-age-key]]",
      "  onepassword-secrets.mts pull <dir|group> [--force] [--out <dir>]",
      "",
      "Commands:",
      "  list    Every secret file found on disk, and whether 1Password already holds a",
      "          matching attachment. Read-only.",
      "",
      "  push    Upload files that are new or whose content changed. Files whose plaintext",
      "          is already gone locally (the create-*.sh scripts delete it after",
      "          encrypting) are sops-decrypted to a 0600 temp file, uploaded, and the temp",
      `          file removed; that needs ${AGE_KEY_FILENAME} at the repo root, or`,
      "          $SOPS_AGE_KEY_FILE pointing at it. Those files are compared ignoring blank",
      "          lines, because a sops dotenv round-trip drops them and would otherwise",
      "          report every such file as changed on every run.",
      "",
      "  pull    Restore a directory's plaintext from 1Password so you can edit it and",
      "          re-encrypt. Resolves the target from 1Password (group name or",
      `          ${REPO_PATH_FIELD}), not from what is on disk, so it still works after the`,
      "          local copy is gone. Files are written 0600.",
      "",
      "Options:",
      "  --vault <name>",
      `      1Password vault to read and write. Default: ${DEFAULT_VAULT} (or $OP_VAULT).`,
      "",
      "  --repo-root <path>",
      "      Repo to scan. Default: the parent of this script.",
      "",
      "  --only <path|group>",
      "      Limit push/list to one group name, directory, or file. Repeatable. Without",
      "      it, every secret in the repo is in scope.",
      "",
      "  --dry-run",
      "      push only. Classify every file as new / changed / unchanged and print what",
      "      would happen, writing nothing to 1Password and deleting nothing locally.",
      "",
      "  --offline",
      "      list only. Skip 1Password entirely and show just the local inventory. Useful",
      "      when op is not signed in.",
      "",
      "  --delete-after-push",
      "      push only. Delete each local plaintext file once it is safely in 1Password.",
      "      Exit code 0 is not treated as proof: the attachment is downloaded again and",
      "      its sha256 compared to the local file, and only an exact match allows the",
      "      delete. A mismatch keeps the file and reports it. After this, 1Password holds",
      "      the only plaintext copy and pull is the only way back.",
      "",
      "  --delete-age-key",
      "      Lets --delete-after-push delete home-infra-private.agekey too. Without it that",
      "      one file is always kept, because losing it makes every *.encrypted file in",
      "      this repo permanently unreadable — including the ones this script decrypts.",
      "      Has no effect on its own.",
      "",
      "  --force",
      "      pull only. Overwrite files that already exist. Without it, existing files are",
      "      skipped and reported.",
      "",
      "  --out <dir>",
      "      pull only. Write under this directory instead of into the repo, preserving the",
      `      ${REPO_PATH_FIELD} layout. Use it to inspect or diff a restore without touching`,
      "      the working tree.",
    ].join("\n"),
  )
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      vault: { type: "string" },
      "repo-root": { type: "string" },
      only: { type: "string", multiple: true },
      offline: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "delete-after-push": { type: "boolean", default: false },
      "delete-age-key": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help || positionals.length === 0) {
    usage()
    return
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const options: Options = {
    vault: values.vault ?? DEFAULT_VAULT,
    repoRoot: resolve(values["repo-root"] ?? join(scriptDir, "..")),
    dryRun: values["dry-run"] === true,
    force: values.force === true,
    offline: values.offline === true,
    only: values.only ?? [],
    out: values.out,
    deleteAfterPush: values["delete-after-push"] === true,
    deleteAgeKey: values["delete-age-key"] === true,
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "op-secrets-"))
  chmodSync(tmpRoot, 0o700)
  try {
    const [command, ...rest] = positionals
    if (command === "list") commandList(options)
    else if (command === "push") commandPush(options, tmpRoot)
    else if (command === "pull") {
      if (rest.length !== 1) fail("pull takes exactly one <dir|group> argument")
      commandPull(options, rest[0], tmpRoot)
    } else fail(`unknown command "${command}"`)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main()

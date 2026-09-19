#!/usr/bin/env -S node --experimental-strip-types
// Reads and writes this repo's SOPS+age secrets. The ciphertext in git is the only copy
// of each secret; 1Password holds one thing, the age private key.
//
// The key is fetched with `op read` into SOPS_AGE_KEY in the environment of each sops
// child process, once per run. It is never written to disk, never logged, and never
// passed as an argument.
//
// Usage:
//   ./scripts/onepassword-secrets.mts list [--only <path|group>]...
//   ./scripts/onepassword-secrets.mts show <file>
//   ./scripts/onepassword-secrets.mts edit <file>
//   ./scripts/onepassword-secrets.mts new <file> [--from <path>]
//   ./scripts/onepassword-secrets.mts rotate-age-key --new-recipient <age1...> [--dry-run]
//   ./scripts/onepassword-secrets.mts migrate --verify [--only <group>] [--report <path>]
//   ./scripts/onepassword-secrets.mts push ...   (migration only; see usage)
//   ./scripts/onepassword-secrets.mts pull ...   (migration only; see usage)
//
// Global flags: --vault <name> (default Private, or $OP_VAULT), --repo-root <path>

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  constants as fsConstants,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
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

// The 1Password item holding the age private key, and the suffix every attachment on it
// that is a key must carry. A rotation puts a second key on the same item for a while
// (see docs/specs/age-key-only-secrets/plan.md), so every matching attachment is read and
// they are handed to sops together.
const AGE_KEY_GROUP = "sops-age-key"
const AGE_KEY_ITEM_TITLE = ITEM_TITLE_PREFIX + AGE_KEY_GROUP
const AGE_KEY_SUFFIX = ".agekey"
// Rotation step 8 renames the old key to home-infra-private-retired-<YYYYMMDD>.agekey. It
// stays in 1Password for git history but is never loaded again, here or in the cluster.
const RETIRED_KEY_MARKER = "-retired-"

function isActiveAgeKey(name: string): boolean {
  return name.endsWith(AGE_KEY_SUFFIX) && !name.includes(RETIRED_KEY_MARKER)
}

// The one declaration of the recipient every *.encrypted file is encrypted to.
const SOPS_CONFIG_INCLUDE = "scripts/_sops_config.include.sh"

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
// ever exists, on this disk or any other. The suffix stops distinguishing anything once no
// secret has a plaintext original at all, and comes out then (plan, "Dropping
// .public-key-encrypted").
const PUBLIC_KEY_ENCRYPTED_SUFFIX = ".public-key-encrypted"

// A plaintext file with no ciphertext sibling. Before this change those were pushed to
// 1Password; now they are the orphan list, and `list` reports each as something to encrypt
// into git or delete. A local *.agekey is reported separately: it is deleted, never
// encrypted, once the 1Password copy is confirmed.
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
  ".": AGE_KEY_GROUP,
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

type SopsFormat = "dotenv" | "binary" | "json"

interface SecretFile {
  /** repo-relative path of the plaintext file (which normally does not exist) */
  relPath: string
  /** repo-relative directory holding it ("." for repo root) */
  relDir: string
  /** basename; doubles as the 1Password file attachment name */
  label: string
  /** absolute path of the plaintext file */
  absPath: string
  /** a committed `<relPath>.encrypted` sibling exists */
  hasCiphertext: boolean
  /** a plaintext copy is sitting in the working tree */
  hasPlaintext: boolean
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

/** Progress and diagnostics go to stderr so `show <file> | ...` pipes only the secret. */
function note(message: string): void {
  console.error(message)
}

/**
 * Runs a command capturing stdout as a Buffer. stdout may hold plaintext secrets, so
 * callers must never log it; only stderr is ever surfaced.
 */
function run(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  input?: string,
): CommandResult {
  const result = spawnSync(command, args, {
    env: env ?? process.env,
    input,
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
  note(`op connected; vault "${vault}" reachable`)
}

function requireSops(): void {
  const version = run("sops", ["--version"])
  if (version.status !== 0) {
    fail(`sops --version failed:\n${version.stderr.trim()}`)
  }
}

// ---------------------------------------------------------------------------
// The age private key
// ---------------------------------------------------------------------------

let cachedAgeKeys: string[] | undefined

/**
 * Every non-retired `*.agekey` attachment on the sops-age-key item, one entry per
 * attachment. Newline-joined they become SOPS_AGE_KEY; sops parses that as the contents of
 * a key file, so several identities in it all get tried. That is what makes the two-key
 * window in the middle of a rotation work, both here and in the cluster's sops-age secret.
 *
 * Read once per run and kept in a module-level variable, so 1Password prompts once no
 * matter how many files a command touches. It is never written anywhere.
 */
function ageKeys(vault: string): string[] {
  if (cachedAgeKeys !== undefined) return cachedAgeKeys

  const refs: string[] = []
  const override = process.env.OP_AGE_KEY_REF
  if (override) {
    refs.push(override)
  } else {
    // Resolve the title to an id first. The title contains spaces, which an argv array
    // handles fine, but a renamed item then fails here with a clear message instead of
    // surfacing as an op:// path that does not parse.
    const itemId = listItemsByTitle(vault).get(AGE_KEY_ITEM_TITLE)
    if (!itemId) {
      fail(
        `no 1Password item titled "${AGE_KEY_ITEM_TITLE}" in vault ${vault}. ` +
          `That item holds the age private key; set $OP_AGE_KEY_REF to an op:// reference ` +
          `to point somewhere else.`,
      )
    }
    const item = getItem(itemId, vault)
    for (const file of item.files ?? []) {
      if (isActiveAgeKey(file.name)) refs.push(`op://${vault}/${itemId}/${file.name}`)
    }
    if (refs.length === 0) {
      fail(
        `item "${AGE_KEY_ITEM_TITLE}" has no *${AGE_KEY_SUFFIX} file attachment ` +
          `(names containing "${RETIRED_KEY_MARKER}" are ignored)`,
      )
    }
  }

  const keys: string[] = []
  for (const ref of refs) {
    const result = op(["read", ref])
    if (result.status !== 0) {
      // stderr only. The failing value is the private key; it must not reach a log.
      fail(`reading the age private key from ${ref} failed:\n${result.stderr.trim()}`)
    }
    const key = result.stdout.toString("utf8").trim()
    if (!key.includes("AGE-SECRET-KEY-")) {
      fail(`${ref} does not contain an age private key`)
    }
    keys.push(key)
  }
  if (refs.length > 1) {
    note(`read ${refs.length} age identities from "${AGE_KEY_ITEM_TITLE}" (rotation in progress)`)
  }
  cachedAgeKeys = keys
  return cachedAgeKeys
}

/**
 * The public key of every identity in 1Password, derived with `age-keygen -y`. The private
 * key goes in on stdin, never as an argument or a file.
 */
function storedRecipients(vault: string): string[] {
  const recipients: string[] = []
  for (const key of ageKeys(vault)) {
    const result = run("age-keygen", ["-y"], undefined, `${key}\n`)
    if (result.status !== 0) {
      fail(`age-keygen -y rejected a key from 1Password:\n${result.stderr.trim()}`)
    }
    recipients.push(...result.stdout.toString("utf8").split("\n").filter(Boolean))
  }
  return recipients
}

// Set by main() to an empty directory inside its private temp dir.
let emptyConfigHome: string | undefined

/**
 * The environment for a sops child that needs to decrypt, holding only the 1Password keys.
 *
 * sops merges identities from every source it finds: SOPS_AGE_KEY_FILE, SOPS_AGE_KEY,
 * SOPS_AGE_KEY_CMD, and the default keys.txt under the user config dir
 * (https://getsops.io/docs/usage/identities/age/). Any of them left in place would let a
 * decrypt succeed while the 1Password copy is wrong or missing. The variables are deleted,
 * and XDG_CONFIG_HOME points at an empty directory so no keys.txt is found; sops honours
 * XDG_CONFIG_HOME on macOS too.
 */
function sopsEnv(vault: string): NodeJS.ProcessEnv {
  if (!emptyConfigHome) fail("internal: sopsEnv called before main() set up its temp dir")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOPS_AGE_KEY: ageKeys(vault).join("\n"),
    XDG_CONFIG_HOME: emptyConfigHome,
  }
  delete env.SOPS_AGE_KEY_FILE
  delete env.SOPS_AGE_KEY_CMD
  delete env.SOPS_AGE_SSH_PRIVATE_KEY_FILE
  return env
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

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

  function addCandidate(relPath: string, found: { ciphertext: boolean; plaintext: boolean }): void {
    const label = basename(relPath)
    if (isExcluded(label)) return
    // A plaintext secret in git is a bug, not something to report as an orphan. The one
    // current hit is the committed Home Assistant secrets.yaml placeholder stub.
    if (tracked.has(relPath)) return
    const existing = candidates.get(relPath)
    if (existing) {
      existing.hasCiphertext ||= found.ciphertext
      existing.hasPlaintext ||= found.plaintext
      return
    }
    candidates.set(relPath, {
      relPath,
      relDir: dirname(relPath),
      label,
      absPath: join(repoRoot, relPath),
      hasCiphertext: found.ciphertext,
      hasPlaintext: found.plaintext,
      publicKeyEncrypted: label.endsWith(PUBLIC_KEY_ENCRYPTED_SUFFIX),
    })
  }

  for (const abs of walk(repoRoot)) {
    const relPath = relative(repoRoot, abs)
    const label = basename(relPath)
    if (label.endsWith(".encrypted")) {
      const plain = relPath.slice(0, -".encrypted".length)
      addCandidate(plain, {
        ciphertext: true,
        plaintext: existsSync(join(repoRoot, plain)),
      })
    } else if (isOrphanCandidate(label)) {
      addCandidate(relPath, { ciphertext: false, plaintext: true })
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

function needsDecrypt(file: SecretFile): boolean {
  return file.hasCiphertext && !file.hasPlaintext
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

// ---------------------------------------------------------------------------
// Hashing and sops formats
// ---------------------------------------------------------------------------

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function sha256File(path: string): string {
  return sha256(readFileSync(path))
}

/**
 * Drops blank lines. A sops dotenv round-trip is byte-identical to the original except
 * that blank lines are discarded — comments, quoting and values all survive. The only
 * thing left to compare a 1Password attachment against is that round-trip, so without
 * this every dotenv file that had a blank line reports as different forever.
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

function sopsFormat(encryptedPath: string, label: string): SopsFormat {
  if (label.startsWith(".env") || label.startsWith("env.")) return "dotenv"
  const text = readFileSync(encryptedPath, "utf8")
  if (!text.trimStart().startsWith("{")) return "dotenv"
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail(`${encryptedPath} starts with "{" but is not valid JSON: ${(error as Error).message}`)
  }
  const keys = Object.keys(parsed).filter((key) => key !== "sops")
  return keys.length === 1 && keys[0] === "data" ? "binary" : "json"
}

/** Format for a file that does not exist yet, so there is nothing to sniff. */
function formatForNewFile(label: string): SopsFormat {
  if (label.startsWith(".env") || label.startsWith("env.")) return "dotenv"
  if (label.endsWith(".json")) return "json"
  return "binary"
}

/**
 * The age recipients a ciphertext file records. This is the authority on who can read a
 * given file, which is what makes a half-finished rotation visible rather than quiet.
 */
function recipientsOf(encryptedPath: string, format: SopsFormat): string[] {
  const text = readFileSync(encryptedPath, "utf8")
  if (format === "dotenv") {
    return [...text.matchAll(/^sops_age__list_\d+__map_recipient=(\S+)$/gm)].map(
      (match) => match[1],
    )
  }
  const parsed = JSON.parse(text) as { sops?: { age?: { recipient?: string }[] } }
  return (parsed.sops?.age ?? [])
    .map((entry) => entry.recipient)
    .filter((recipient): recipient is string => Boolean(recipient))
}

const NON_AGE_KEY_TYPES = ["pgp", "kms", "gcp_kms", "azure_kv", "hc_vault"]

/**
 * Problems in a file's sops metadata that recipientsOf cannot see: a key of another type
 * can decrypt the file too, and rotate --rm-age would never remove it. sops' MAC does not
 * cover this metadata, so an added entry leaves the file valid.
 */
function foreignKeysOf(encryptedPath: string, format: SopsFormat): string[] {
  const text = readFileSync(encryptedPath, "utf8")
  const types = new Set<string>()
  let keyGroups = 0
  if (format === "dotenv") {
    for (const match of text.matchAll(/^sops_([a-z_]+?)__list_(\d+)__/gm)) {
      if (NON_AGE_KEY_TYPES.includes(match[1])) types.add(match[1])
      if (match[1] === "key_groups") keyGroups = Math.max(keyGroups, Number(match[2]) + 1)
    }
    // Inside a key group the type follows the group index.
    for (const match of text.matchAll(/^sops_key_groups__list_\d+__map_([a-z_]+?)__/gm)) {
      if (NON_AGE_KEY_TYPES.includes(match[1])) types.add(match[1])
    }
  } else {
    const sops = (JSON.parse(text) as { sops?: Record<string, unknown> }).sops ?? {}
    const groups = Array.isArray(sops.key_groups)
      ? (sops.key_groups as Record<string, unknown>[])
      : []
    keyGroups = groups.length
    for (const holder of [sops, ...groups]) {
      for (const type of NON_AGE_KEY_TYPES) {
        const entries = holder?.[type]
        if (Array.isArray(entries) && entries.length > 0) types.add(type)
      }
    }
  }
  const problems: string[] = []
  if (types.size > 0) problems.push(`non-age keys: ${[...types].sort().join(", ")}`)
  if (keyGroups > 1) problems.push(`${keyGroups} key groups`)
  return problems
}

/** The single declared recipient, read from the file that declares it. */
function configuredRecipient(repoRoot: string): string {
  const path = join(repoRoot, SOPS_CONFIG_INCLUDE)
  if (!existsSync(path)) fail(`${SOPS_CONFIG_INCLUDE} not found under ${repoRoot}`)
  const match = readFileSync(path, "utf8").match(/^age_key_public="([^"]+)"/m)
  if (!match) fail(`no age_key_public assignment in ${SOPS_CONFIG_INCLUDE}`)
  return match[1]
}

function shortRecipient(recipient: string): string {
  return recipient.length > 20 ? `${recipient.slice(0, 12)}…${recipient.slice(-6)}` : recipient
}

/** Decrypts to a Buffer. Callers must not log the result. */
function decryptBytes(encryptedPath: string, format: SopsFormat, vault: string): Buffer {
  const result = run(
    "sops",
    ["decrypt", "--input-type", format, "--output-type", format, encryptedPath],
    sopsEnv(vault),
  )
  if (result.status !== 0) {
    fail(`sops decrypt failed for ${encryptedPath}:\n${result.stderr.trim()}`)
  }
  return result.stdout
}

// ---------------------------------------------------------------------------
// 1Password items
// ---------------------------------------------------------------------------

function listItemsByTitle(vault: string): Map<string, string> {
  const items = opJson<{ id: string; title: string }[]>(["item", "list", "--vault", vault])
  const map = new Map<string, string>()
  for (const item of items) {
    if (item.title.startsWith(ITEM_TITLE_PREFIX)) map.set(item.title, item.id)
    if (item.title === LEGACY_ITEM_TITLE) {
      note(`Note: legacy item "${LEGACY_ITEM_TITLE}" present; never read or written here.`)
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
 * Reads an attachment's bytes from `op read` stdout, so no plaintext copy is written to
 * disk for a comparison. --no-newline keeps op from appending a newline the file lacks.
 */
function readAttachment(vault: string, itemId: string, label: string): Buffer {
  const result = op(["read", "--no-newline", `op://${vault}/${itemId}/${label}`])
  if (result.status !== 0) {
    fail(`op read of "${label}" from item ${itemId} failed:\n${result.stderr.trim()}`)
  }
  return result.stdout
}

function hashAttachment(vault: string, itemId: string, label: string): ContentHashes {
  return hashesOf(readAttachment(vault, itemId, label))
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

function repoPathOf(item: OpItem): string | undefined {
  return (item.fields ?? []).find(
    (field) => field.label === REPO_PATH_FIELD || field.id === REPO_PATH_FIELD,
  )?.value
}

// ---------------------------------------------------------------------------
// Filters and options
// ---------------------------------------------------------------------------

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
  only: string[]
  out?: string
  from?: string
  report?: string
  newRecipient?: string
  verify: boolean
  deleteAfterPush: boolean
  deleteAgeKey: boolean
}

// ---------------------------------------------------------------------------
// Resolving a <file> argument
// ---------------------------------------------------------------------------

interface ResolvedSecret {
  /** absolute path of the plaintext name; nothing is expected to exist there */
  absPath: string
  /** absolute path of the ciphertext */
  encryptedPath: string
  relPath: string
  label: string
}

/**
 * Accepts either side of the pair (`.env.secret.db` or `.env.secret.db.encrypted`) and
 * resolves it against the current directory first, then the repo root, so both a path
 * tab-completed inside an app directory and a repo-relative path work.
 */
function resolveSecret(repoRoot: string, arg: string, mustExist: boolean): ResolvedSecret {
  const trimmed = arg.replace(/\/+$/, "")
  const plain = trimmed.endsWith(".encrypted")
    ? trimmed.slice(0, -".encrypted".length)
    : trimmed
  const candidates = isAbsolute(plain)
    ? [plain]
    : [...new Set([resolve(process.cwd(), plain), resolve(repoRoot, plain)])]

  const chosen = mustExist
    ? candidates.find((candidate) => existsSync(`${candidate}.encrypted`))
    : candidates.find((candidate) => existsSync(dirname(candidate)))
  if (!chosen) {
    fail(
      mustExist
        ? `no ciphertext found for "${arg}"; looked for:\n  ${candidates
            .map((candidate) => `${candidate}.encrypted`)
            .join("\n  ")}`
        : `no directory to write "${arg}" into; looked for:\n  ${candidates
            .map((candidate) => dirname(candidate))
            .join("\n  ")}`,
    )
  }

  const relPath = relative(repoRoot, chosen)
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    fail(`"${arg}" resolves to ${chosen}, which is outside ${repoRoot}`)
  }
  return {
    absPath: chosen,
    encryptedPath: `${chosen}.encrypted`,
    relPath,
    label: basename(chosen),
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function commandList(options: Options): void {
  const expected = configuredRecipient(options.repoRoot)
  const groups = selectGroups(discover(options.repoRoot), options.only)

  const labelWidth = Math.max(
    ...groups.flatMap((group) => group.files.map((file) => file.label.length)),
  )

  let fileCount = 0
  let staleRecipient = 0
  let strayPlaintext = 0
  let orphans = 0
  let localAgeKeys = 0

  console.log(`recipient of record: ${expected}  (${SOPS_CONFIG_INCLUDE})`)
  for (const group of groups) {
    console.log(`\n${group.title}  [${group.relDir}]`)
    for (const file of group.files) {
      fileCount += 1
      const notes: string[] = []
      let mark = OK
      let detail: string

      if (!file.hasCiphertext && file.label.endsWith(AGE_KEY_SUFFIX)) {
        // Not an orphan: the age key never gets ciphertext. It belongs in 1Password only.
        localAgeKeys += 1
        mark = BAD
        detail = "AGE PRIVATE KEY on disk"
        notes.push(
          "delete it once `age-keygen -y` on the 1Password copy prints age_key_public " +
            "(docs/specs/age-key-only-secrets/summary.md, step 7)",
        )
      } else if (!file.hasCiphertext) {
        orphans += 1
        mark = BAD
        detail = "ORPHAN: plaintext only, no ciphertext in git"
      } else {
        const format = sopsFormat(`${file.absPath}.encrypted`, file.label)
        const recipients = recipientsOf(`${file.absPath}.encrypted`, format)
        detail = `${format.padEnd(6)}  ${recipients.map(shortRecipient).join(", ") || "no age recipient"}`
        // Exactly one, not "includes": after rotating away from a compromised key, a file
        // that still names the old key alongside the new one is still readable by it.
        if (recipients.length !== 1 || recipients[0] !== expected) {
          staleRecipient += 1
          mark = BAD
          notes.push(
            recipients.includes(expected)
              ? `${recipients.length} recipients; only the one of record belongs`
              : "recipient is not the one of record; rotation did not finish",
          )
        }
        const foreign = foreignKeysOf(`${file.absPath}.encrypted`, format)
        if (foreign.length > 0) {
          if (mark === OK) staleRecipient += 1
          mark = BAD
          notes.push(`${foreign.join("; ")}; only the age recipient of record belongs`)
        }
        if (file.hasPlaintext) {
          strayPlaintext += 1
          mark = BAD
          notes.push("plaintext sibling on disk; encrypt it and delete it")
        }
      }
      console.log(`  ${mark} ${file.label.padEnd(labelWidth)}  ${detail}`)
      for (const line of notes) console.log(`     ${line}`)
    }
  }

  console.log(`\n${fileCount} secret file(s) in ${groups.length} group(s)`)
  if (staleRecipient === 0 && strayPlaintext === 0 && orphans === 0 && localAgeKeys === 0) {
    console.log(`${OK} every file is encrypted to the recipient of record, and only to git`)
    return
  }
  if (staleRecipient > 0) {
    console.log(`${BAD} ${staleRecipient} file(s) not encrypted to the recipient of record alone`)
  }
  if (strayPlaintext > 0) console.log(`${BAD} ${strayPlaintext} file(s) with plaintext on disk`)
  if (orphans > 0) console.log(`${BAD} ${orphans} plaintext file(s) with no ciphertext in git`)
  if (localAgeKeys > 0) console.log(`${BAD} ${localAgeKeys} age private key file(s) on disk`)
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// show / edit / new
// ---------------------------------------------------------------------------

function commandShow(options: Options, target: string): void {
  requireSops()
  preflight(options.vault)
  const secret = resolveSecret(options.repoRoot, target, true)
  const format = sopsFormat(secret.encryptedPath, secret.label)
  process.stdout.write(decryptBytes(secret.encryptedPath, format, options.vault))
}

function commandEdit(options: Options, target: string): void {
  requireSops()
  preflight(options.vault)
  const secret = resolveSecret(options.repoRoot, target, true)
  const format = sopsFormat(secret.encryptedPath, secret.label)

  // sops decrypts to a temp file inside a 0700 temp directory of its own, hands it to the
  // editor, re-encrypts on save and removes it. The plaintext never exists at a repo path.
  // Re-encryption keeps the file's existing recipients, so editing during a half-finished
  // rotation does not quietly move the file back to the retired key.
  const result = spawnSync(
    "sops",
    ["edit", "--input-type", format, "--output-type", format, secret.encryptedPath],
    { env: editorSafeSopsEnv(options.vault), stdio: "inherit" },
  )
  if (result.error) fail(`sops edit failed to start: ${result.error.message}`)
  if ((result.status ?? 1) !== 0) fail(`sops edit exited ${result.status}`)
  note(`${OK} ${secret.relPath}.encrypted`)
}

/** Single-quotes a word for the shlex split sops applies to SOPS_EDITOR. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'"'"'`)}'`
}

/**
 * sopsEnv for `sops edit`, which starts the editor with its own environment. Without this
 * the editor, and every shell, plugin or terminal it spawns, would hold SOPS_AGE_KEY. So
 * SOPS_EDITOR runs the editor through `env -u SOPS_AGE_KEY`, and gives it back the
 * caller's XDG_CONFIG_HOME so its own config still loads.
 */
function editorSafeSopsEnv(vault: string): NodeJS.ProcessEnv {
  const env = sopsEnv(vault)
  // The order sops itself uses.
  const editor = process.env.SOPS_EDITOR || process.env.EDITOR || defaultEditor()
  const configHome =
    process.env.XDG_CONFIG_HOME === undefined
      ? ["-u", "XDG_CONFIG_HOME"]
      : [shellQuote(`XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`)]
  env.SOPS_EDITOR = ["env", "-u", "SOPS_AGE_KEY", ...configHome, editor].join(" ")
  return env
}

/** The editor sops falls back to when EDITOR is unset: the first of vim, nano, vi on PATH. */
function defaultEditor(): string {
  for (const name of ["vim", "nano", "vi"]) {
    for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      try {
        accessSync(join(dir, name), fsConstants.X_OK)
        return name
      } catch {
        // not here; keep looking
      }
    }
  }
  fail("EDITOR is unset and none of vim, nano, vi is on PATH; set EDITOR")
}

function runEditor(path: string): void {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? defaultEditor()
  const parts = editor.split(/\s+/).filter(Boolean)
  const result = spawnSync(parts[0], [...parts.slice(1), path], { stdio: "inherit" })
  if (result.error) fail(`could not start editor "${editor}": ${result.error.message}`)
  if ((result.status ?? 1) !== 0) fail(`editor "${editor}" exited ${result.status}; wrote nothing`)
}

function commandNew(options: Options, target: string, tmpRoot: string): void {
  requireSops()
  const recipient = configuredRecipient(options.repoRoot)
  const secret = resolveSecret(options.repoRoot, target, false)
  if (existsSync(secret.encryptedPath)) {
    fail(`${secret.relPath}.encrypted already exists; use \`edit\` to change it`)
  }
  const format = formatForNewFile(secret.label)

  const workDir = mkdtempSync(join(tmpRoot, "new-"))
  chmodSync(workDir, 0o700)
  const scratch = join(workDir, secret.label)
  try {
    if (options.from) {
      const seed = resolve(process.cwd(), options.from)
      const fallback = resolve(options.repoRoot, options.from)
      const source = existsSync(seed) ? seed : fallback
      if (!existsSync(source)) fail(`--from ${options.from} does not exist`)
      writeFileSync(scratch, readFileSync(source), { mode: 0o600 })
    } else {
      writeFileSync(scratch, "", { mode: 0o600 })
    }
    chmodSync(scratch, 0o600)

    runEditor(scratch)
    if (statSync(scratch).size === 0) {
      fail(`${secret.label} is empty after editing; nothing written`)
    }

    // Encrypt to a temp file next to the target and rename. Redirecting into the target
    // truncates it before sops runs, and for a file whose only copy is the ciphertext that
    // destroys it. Same reason encrypt-env-files.sh does it this way.
    const staging = `${secret.encryptedPath}.tmp.${process.pid}`
    const result = run("sops", [
      "encrypt",
      "--age",
      recipient,
      "--input-type",
      format,
      "--output-type",
      format,
      "--filename-override",
      secret.relPath,
      scratch,
    ])
    if (result.status !== 0) {
      fail(`sops encrypt failed for ${secret.relPath}:\n${result.stderr.trim()}`)
    }
    try {
      writeFileSync(staging, result.stdout, { mode: 0o644 })
      renameSync(staging, secret.encryptedPath)
    } catch (error) {
      if (existsSync(staging)) unlinkSync(staging)
      throw error
    }
    note(`${OK} wrote ${secret.relPath}.encrypted (${format}, ${shortRecipient(recipient)})`)
    note(`   git add ${secret.relPath}.encrypted`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// rotate-age-key
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })
  if (result.error) fail(`git ${args.join(" ")} failed to start: ${result.error.message}`)
  return { status: result.status ?? 1, stdout: result.stdout ?? "" }
}

/**
 * Proves 1Password already holds the private key for `recipient`: one of its identities
 * must derive exactly that public key. This is the gate that keeps ciphertext from ever
 * being moved to a key that exists in only one place. It deliberately does not go through
 * sops, which would also accept a key from any other identity source on this machine.
 */
function assertKeyIsStored(recipient: string, vault: string): void {
  if (!storedRecipients(vault).includes(recipient)) {
    fail(
      `no age key in 1Password has the public key ${shortRecipient(recipient)}.\n` +
        `Upload the new private key as a second *${AGE_KEY_SUFFIX} attachment on ` +
        `"${AGE_KEY_ITEM_TITLE}" first (rotation step 2), then re-run. Nothing was changed.`,
    )
  }
}

function commandRotateAgeKey(options: Options): void {
  const newRecipient = options.newRecipient
  if (!newRecipient) fail("rotate-age-key needs --new-recipient <age1...>")
  // Rotating a subset would leave the rest on the retired key while age_key_public already
  // named the new one, which is exactly the half-finished state `list` exists to catch.
  if (options.only.length > 0) fail("rotate-age-key rotates every file; --only is not allowed")
  requireSops()

  const oldRecipient = configuredRecipient(options.repoRoot)
  if (newRecipient === oldRecipient) {
    fail(`--new-recipient is already the recipient of record in ${SOPS_CONFIG_INCLUDE}`)
  }

  const status = git(options.repoRoot, ["status", "--porcelain"])
  if (status.status !== 0) fail("git status failed")
  if (status.stdout.trim() !== "") {
    fail(
      "working tree is not clean. `git checkout -- .` is the rollback for this command, so " +
        "it must start from a clean tree:\n" +
        status.stdout.trimEnd(),
    )
  }
  const branch = git(options.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()
  if (branch === "main") fail("refusing to rotate on main; make a branch first")

  // Syntax check before anything else touches 1Password: `age -r` rejects a malformed
  // recipient without needing a key.
  const recipientCheck = run("age", ["-r", newRecipient, "-o", "/dev/null"], undefined, "")
  if (recipientCheck.status !== 0) {
    fail(`--new-recipient is not a valid age recipient:\n${recipientCheck.stderr.trim()}`)
  }

  preflight(options.vault)
  assertKeyIsStored(newRecipient, options.vault)
  note(`${OK} 1Password holds a key that reads ${shortRecipient(newRecipient)}`)

  const targets = discover(options.repoRoot).flatMap((group) =>
    group.files.filter((file) => file.hasCiphertext),
  )

  console.log(
    `\n${shortRecipient(oldRecipient)} -> ${shortRecipient(newRecipient)} ` +
      `across ${targets.length} file(s)${options.dryRun ? " (dry run)" : ""}\n`,
  )

  let rotated = 0
  let already = 0
  for (const file of targets) {
    const encryptedPath = `${file.absPath}.encrypted`
    const format = sopsFormat(encryptedPath, file.label)
    const recipients = recipientsOf(encryptedPath, format)
    const removing = recipients.filter((recipient) => recipient !== newRecipient)
    if (removing.length === 0) {
      already += 1
      console.log(`  ${OK} ${"already".padEnd(8)} ${file.relPath}`)
      continue
    }
    if (options.dryRun) {
      console.log(`  ${WARN} ${"would".padEnd(8)} ${file.relPath}  (${format})`)
      continue
    }
    const result = run(
      "sops",
      [
        "rotate",
        "-i",
        "--add-age",
        newRecipient,
        "--rm-age",
        removing.join(","),
        "--input-type",
        format,
        "--output-type",
        format,
        encryptedPath,
      ],
      sopsEnv(options.vault),
    )
    if (result.status !== 0) {
      console.error(`  ${BAD} ${"FAILED".padEnd(8)} ${file.relPath}\n${result.stderr.trim()}`)
      fail(
        `stopped at ${file.relPath}.encrypted after rotating ${rotated} file(s).\n` +
          `Roll back with:  git checkout -- .`,
      )
    }
    rotated += 1
    console.log(`  ${OK} ${"rotated".padEnd(8)} ${file.relPath}`)
  }

  if (options.dryRun) {
    console.log(
      `\nDRY RUN: ${targets.length - already} file(s) to rotate, ${already} already on the ` +
        `new recipient. ${SOPS_CONFIG_INCLUDE} not touched.`,
    )
    return
  }

  const configPath = join(options.repoRoot, SOPS_CONFIG_INCLUDE)
  const updated = readFileSync(configPath, "utf8").replace(
    /^age_key_public="[^"]+"/m,
    `age_key_public="${newRecipient}"`,
  )
  writeFileSync(configPath, updated)

  console.log(
    `\n${rotated} rotated, ${already} already current. ${SOPS_CONFIG_INCLUDE} now declares ` +
      `the new recipient.\n\nStill to do, in order (see docs/specs/age-key-only-secrets/plan.md):\n` +
      `  1. ./scripts/onepassword-secrets.mts list   # must exit 0\n` +
      `  2. review git diff --stat, commit, PR, merge\n` +
      `  3. confirm Flux is green: flux --context nas get kustomization apps\n` +
      `  4. re-apply the cluster secret with the new key only, naming it (with no argument\n` +
      `     it applies both, since the old one is not renamed until step 5):\n` +
      `     ./scripts/create-sops-age-decryption-secret.sh home-infra-private-<YYYYMMDD>${AGE_KEY_SUFFIX}\n` +
      `  5. in 1Password, rename the retired attachment to ` +
      `home-infra-private-retired-<YYYYMMDD>${AGE_KEY_SUFFIX} and the new one to ` +
      `home-infra-private${AGE_KEY_SUFFIX}\n` +
      `  6. refresh the offline copy of the key`,
  )
}

// ---------------------------------------------------------------------------
// migrate --verify
// ---------------------------------------------------------------------------

type Verdict =
  | "match"
  | "match (blank lines only)"
  | "MISMATCH"
  | "1PASSWORD ONLY"
  | "age key (stays)"

interface VerifyRow {
  group: string
  attachment: string
  repoPath: string
  verdict: Verdict
  onePasswordHash: string
  gitHash: string
  detail: string
}

// What a dotenv key looks like. Anything before an "=" that does not match (a base64
// continuation line, a pasted blob) may be part of a value, so it is never printed.
const DOTENV_KEY = /^[A-Za-z_][\w.-]*$/

interface DotenvHashes {
  values: Map<string, string>
  /** sorted hashes of lines with no printable key name */
  unnamed: string[]
}

/**
 * The quote a value leaves open at the end of `text`, or undefined when it ends closed.
 * Backslash escapes count inside double quotes only, as in dotenv.
 */
function openQuoteAfter(text: string, open: string | undefined): string | undefined {
  let quote = open
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote === undefined) {
      if (char === '"' || char === "'") quote = char
    } else if (quote === '"' && char === "\\") {
      i += 1
    } else if (char === quote) {
      quote = undefined
    }
  }
  return quote
}

function dotenvValueHashes(bytes: Buffer): DotenvHashes {
  const values = new Map<string, string>()
  const unnamed: string[] = []
  // A quoted value can span lines. Its continuation lines belong to the key that opened
  // the quote, so the tail of a PEM or base64 blob is never read as a name.
  let current: { key: string; value: string } | undefined
  let quote: string | undefined
  for (const line of bytes.toString("utf8").split("\n")) {
    if (current && quote) {
      current.value += `\n${line}`
      quote = openQuoteAfter(line, quote)
      values.set(current.key, sha256(Buffer.from(current.value, "utf8")))
      continue
    }
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    const key = eq > 0 ? trimmed.slice(0, eq) : ""
    const rest = trimmed.slice(eq + 1)
    // `abc==` is base64 padding, not a key named abc.
    if (DOTENV_KEY.test(key) && !/^=+$/.test(rest)) {
      current = { key, value: rest }
      quote = openQuoteAfter(rest, undefined)
      values.set(key, sha256(Buffer.from(rest, "utf8")))
    } else {
      unnamed.push(sha256(Buffer.from(trimmed, "utf8")))
    }
  }
  unnamed.sort()
  return { values, unnamed }
}

/** Names only. A value, or a diff of values, must never reach the terminal or the report. */
function describeMismatch(onePassword: Buffer, fromGit: Buffer, format: SopsFormat): string {
  if (format !== "dotenv") return "bytes differ"
  const left = dotenvValueHashes(onePassword)
  const right = dotenvValueHashes(fromGit)
  const onlyOnePassword = [...left.values.keys()].filter((key) => !right.values.has(key))
  const onlyGit = [...right.values.keys()].filter((key) => !left.values.has(key))
  const changed = [...left.values.keys()].filter(
    (key) => right.values.has(key) && right.values.get(key) !== left.values.get(key),
  )
  const parts: string[] = []
  // A count, not names: git's side went through sops, so its names are real keys, but the
  // 1Password side is whatever was attached and can hold anything.
  if (onlyOnePassword.length > 0) parts.push(`${onlyOnePassword.length} key(s) in 1Password only`)
  if (onlyGit.length > 0) parts.push(`git only: ${onlyGit.join(", ")}`)
  if (changed.length > 0) parts.push(`different value: ${changed.join(", ")}`)
  if (left.unnamed.join() !== right.unnamed.join()) parts.push("lines with no key name differ")
  return parts.length > 0 ? parts.join("; ") : "same keys and values, different bytes"
}

function commandMigrate(options: Options): void {
  if (!options.verify) {
    fail("migrate only supports --verify. It is read-only and never deletes from 1Password.")
  }
  requireSops()
  preflight(options.vault)

  const titles = listItemsByTitle(options.vault)
  const rows: VerifyRow[] = []
  const seenPaths = new Set<string>()

  for (const [title, itemId] of [...titles].sort(([a], [b]) => a.localeCompare(b))) {
    const group = title.slice(ITEM_TITLE_PREFIX.length)
    if (options.only.length > 0 && !options.only.includes(group)) continue
    const item = getItem(itemId, options.vault)
    const repoPath = repoPathOf(item)
    for (const attachment of item.files ?? []) {
      // The age key is the one thing that stays in 1Password: it is what decrypts git, so
      // it cannot live in git. It has no ciphertext to compare against and is not an orphan.
      if (attachment.name.endsWith(AGE_KEY_SUFFIX)) {
        rows.push({
          group,
          attachment: attachment.name,
          repoPath: repoPath ?? "",
          verdict: "age key (stays)",
          onePasswordHash: "",
          gitHash: "",
          detail: "stays in 1Password by design",
        })
        continue
      }
      if (!repoPath) {
        rows.push({
          group,
          attachment: attachment.name,
          repoPath: "",
          verdict: "1PASSWORD ONLY",
          onePasswordHash: "",
          gitHash: "",
          detail: `item has no ${REPO_PATH_FIELD} field, so no path to compare against`,
        })
        continue
      }
      const relPath = join(repoPath, attachment.name)
      const encryptedPath = join(options.repoRoot, `${relPath}.encrypted`)
      const fromOnePassword = readAttachment(options.vault, itemId, attachment.name)
      const opHashes = hashesOf(fromOnePassword)
      if (!existsSync(encryptedPath)) {
        rows.push({
          group,
          attachment: attachment.name,
          repoPath,
          verdict: "1PASSWORD ONLY",
          onePasswordHash: opHashes.raw,
          gitHash: "",
          detail: `no ${relPath}.encrypted`,
        })
        continue
      }
      seenPaths.add(relPath)
      const format = sopsFormat(encryptedPath, attachment.name)
      const fromGit = decryptBytes(encryptedPath, format, options.vault)
      const gitHashes = hashesOf(fromGit)
      let verdict: Verdict = "MISMATCH"
      let detail = ""
      if (opHashes.raw === gitHashes.raw) {
        verdict = "match"
      } else if (format === "dotenv" && opHashes.normalized === gitHashes.normalized) {
        // A sops dotenv round-trip discards blank lines and nothing else.
        verdict = "match (blank lines only)"
      } else {
        detail = describeMismatch(fromOnePassword, fromGit, format)
      }
      rows.push({
        group,
        attachment: attachment.name,
        repoPath,
        verdict,
        onePasswordHash: opHashes.raw,
        gitHash: gitHashes.raw,
        detail,
      })
    }
  }

  // Ciphertext in git with nothing backing it in 1Password. Informational: after this
  // migration that is the normal state for every file.
  const gitOnly: string[] = []
  for (const group of discover(options.repoRoot)) {
    for (const file of group.files) {
      if (file.hasCiphertext && !seenPaths.has(file.relPath)) gitOnly.push(file.relPath)
    }
  }

  const width = Math.max(...rows.map((row) => row.attachment.length), 10)
  console.log("")
  for (const row of rows) {
    const mark =
      row.verdict === "MISMATCH" || row.verdict === "1PASSWORD ONLY"
        ? BAD
        : row.verdict === "match (blank lines only)"
          ? WARN
          : OK
    console.log(
      `${mark} ${row.verdict.padEnd(24)} ${row.attachment.padEnd(width)}  [${row.group}]` +
        (row.detail ? `\n   ${row.detail}` : ""),
    )
  }

  const mismatches = rows.filter((row) => row.verdict === "MISMATCH").length
  const onePasswordOnly = rows.filter((row) => row.verdict === "1PASSWORD ONLY").length
  console.log(
    `\n${rows.length} attachment(s): ${mismatches} MISMATCH, ${onePasswordOnly} 1PASSWORD ONLY, ` +
      `${gitOnly.length} GIT ONLY (informational)`,
  )

  const reportPath = resolve(
    options.report ??
      join(
        options.repoRoot,
        ".validation-outputs",
        `migrate-verify-${new Date().toISOString().slice(0, 10)}.md`,
      ),
  )
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, renderReport(rows, gitOnly), { mode: 0o600 })
  console.log(`report: ${reportPath}`)

  if (mismatches > 0 || onePasswordOnly > 0) {
    console.log(
      `\n${BAD} not clean. Nothing is deleted from 1Password until this exits 0 and the ` +
        `report has been read.`,
    )
    process.exitCode = 1
    return
  }
  console.log(`\n${OK} clean: every attachment other than the age key is reproducible from git`)
}

function renderReport(rows: VerifyRow[], gitOnly: string[]): string {
  const lines = [
    "# migrate --verify",
    "",
    `Generated ${new Date().toISOString()}. Names and hashes only; no secret values.`,
    "",
    "| Attachment | Group | repo_path | Verdict | 1Password sha256 | git sha256 | Detail |",
    "|---|---|---|---|---|---|---|",
  ]
  for (const row of rows) {
    lines.push(
      `| \`${row.attachment}\` | ${row.group} | ${row.repoPath || "-"} | ${row.verdict} | ` +
        `${row.onePasswordHash.slice(0, 16) || "-"} | ${row.gitHash.slice(0, 16) || "-"} | ` +
        `${row.detail || "-"} |`,
    )
  }
  lines.push("", "## GIT ONLY", "")
  if (gitOnly.length === 0) {
    lines.push("None.")
  } else {
    lines.push("Ciphertext in git with no 1Password attachment. Expected, and the goal.", "")
    for (const path of gitOnly) lines.push(`- \`${path}.encrypted\``)
  }
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// push / pull: migration only, removed once the vault is down to the age key
// ---------------------------------------------------------------------------

/** True when --delete-after-push is allowed to remove this file's local plaintext. */
function deletable(file: SecretFile, options: Options): boolean {
  if (file.label.endsWith(AGE_KEY_SUFFIX)) return options.deleteAgeKey
  return true
}

function classify(
  group: SecretGroup,
  item: OpItem | undefined,
  options: Options,
  tmpRoot: string,
): PushEntry[] {
  const entries: PushEntry[] = []
  for (const file of group.files) {
    let sourcePath = file.absPath
    let decryptFormat: SopsFormat | undefined
    if (needsDecrypt(file)) {
      sourcePath = join(tmpRoot, `decrypted-${group.name}-${file.label}`)
      const encryptedPath = `${file.absPath}.encrypted`
      decryptFormat = sopsFormat(encryptedPath, file.label)
      writeFileSync(sourcePath, decryptBytes(encryptedPath, decryptFormat, options.vault), {
        mode: 0o600,
      })
    } else if (!existsSync(sourcePath)) {
      fail(`${file.relPath} disappeared mid-run`)
    }
    const local = hashesOf(readFileSync(sourcePath))

    const attached = item ? attachmentFor(item, file.label) : undefined
    if (!item || !attached) {
      entries.push({ file, sourcePath, localHash: local.raw, status: "new" })
      continue
    }
    const remote = hashAttachment(options.vault, item.id, file.label)
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

interface PushCounts {
  unchanged: number
  changed: number
  uploaded: number
  deleted: number
  blankLineOnly: number
  skipped: number
}

function commandPush(options: Options, tmpRoot: string): void {
  preflight(options.vault)
  const groups = selectGroups(discover(options.repoRoot), options.only)
  if (groups.some((group) => group.files.some((file) => needsDecrypt(file)))) requireSops()
  const titles = listItemsByTitle(options.vault)

  const counts: PushCounts = {
    unchanged: 0,
    changed: 0,
    uploaded: 0,
    deleted: 0,
    blankLineOnly: 0,
    skipped: 0,
  }
  const wouldDelete: string[] = []

  for (const group of groups) {
    pushGroup(group, options, tmpRoot, titles, counts, wouldDelete)
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
  )
  try {
    console.log(`\n${group.title}  [${group.relDir}]`)
    for (const file of skipped) {
      counts.skipped += 1
      console.log(`  ${OK} skipped   ${file.label} (public-key encrypted, no plaintext)`)
    }
    for (const entry of entries) {
      const mark = entry.status === "unchanged" ? OK : WARN
      const detail = entry.matchedIgnoringBlankLines ? "  (matched ignoring blank lines)" : ""
      console.log(`  ${mark} ${entry.status.padEnd(9)} ${entry.file.label}${detail}`)
    }

    for (const entry of entries) {
      if (entry.status === "unchanged") counts.unchanged += 1
      else if (entry.status === "changed") counts.changed += 1
      else counts.uploaded += 1
      if (entry.matchedIgnoringBlankLines) counts.blankLineOnly += 1
    }

    if (options.dryRun) {
      for (const entry of entries) {
        if (options.deleteAfterPush && entry.file.hasPlaintext && deletable(entry.file, options)) {
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
      if (!entry.file.hasPlaintext) continue
      if (!deletable(entry.file, options)) {
        console.log(`  ${WARN} kept      ${entry.file.label} (age key; needs --delete-age-key)`)
        continue
      }
      // Exit code 0 is not proof the bytes landed; the read-back hash is. Compare the raw
      // hash, never the normalized one — the blank-line tolerance must not decide a delete.
      const remote = hashAttachment(options.vault, item.id, entry.file.label)
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
      if (needsDecrypt(entry.file) && existsSync(entry.sourcePath)) unlinkSync(entry.sourcePath)
    }
  }
}

/**
 * Resolves a pull target against 1Password rather than the working tree. Local discovery
 * cannot be the source of truth here: the plaintext is gone, and for a secret with no
 * ciphertext sibling that leaves nothing on disk to discover — so a disk-driven pull would
 * refuse to restore exactly the files that need restoring.
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
          `item "${item.title}" has no ${REPO_PATH_FIELD} field; use --out to choose a ` +
            `destination directory`,
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

// ---------------------------------------------------------------------------

function usage(): void {
  console.log(
    [
      "onepassword-secrets.mts: read and write this repo's SOPS+age secrets.",
      "",
      "The ciphertext committed here is the only copy of each secret. 1Password holds the",
      `age private key and nothing else: the item "${AGE_KEY_ITEM_TITLE}",`,
      `with one ${AGE_KEY_SUFFIX} file attachment (two while a rotation is in flight). The key is`,
      "read with `op read` into SOPS_AGE_KEY for the sops child processes and is never",
      "written to disk.",
      "",
      "Usage:",
      "  onepassword-secrets.mts list [--only <path|group>]...",
      "  onepassword-secrets.mts show <file>",
      "  onepassword-secrets.mts edit <file>",
      "  onepassword-secrets.mts new <file> [--from <path>]",
      "  onepassword-secrets.mts rotate-age-key --new-recipient <age1...> [--dry-run]",
      "  onepassword-secrets.mts migrate --verify [--only <group>]... [--report <path>]",
      "  onepassword-secrets.mts push [--only <path|group>]... [--dry-run]",
      "                               [--delete-after-push [--delete-age-key]]",
      "  onepassword-secrets.mts pull <dir|group> [--force] [--out <dir>]",
      "",
      "<file> is either side of the pair: .env.secret.db or .env.secret.db.encrypted.",
      "",
      "Commands:",
      "  list    Every ciphertext file, its sops format, and the recipient recorded inside",
      "          it. Reads git only, so it needs neither 1Password nor the key. Exits 1 if",
      "          any file has a recipient other than the one of record, or more than one,",
      "          has a plaintext sibling on disk, or is plaintext with no ciphertext at all,",
      "          or if an age private key file is on disk. Run it after every rotation.",
      "",
      "  show    Decrypt to stdout. Writes nothing.",
      "",
      "  edit    sops edit. sops decrypts to a temp file in its own 0700 temp directory,",
      "          hands it to $EDITOR (without SOPS_AGE_KEY in its environment),",
      "          re-encrypts on save and removes it, keeping the file's current recipients.",
      "",
      "  new     Create a secret that does not exist yet: an empty (or --from seeded) 0600",
      "          file in a 0700 temp directory, $EDITOR, then encrypt to <file>.encrypted.",
      "          Needs no private key, since encrypting only needs the public recipient.",
      "",
      "  rotate-age-key",
      "          The repo-side half of an age key rotation. Refuses to run unless the tree",
      "          is clean, the branch is not main, and a key in 1Password derives",
      "          --new-recipient under `age-keygen -y`. Then `sops rotate` over every",
      `          ciphertext file and rewrites age_key_public in ${SOPS_CONFIG_INCLUDE}.`,
      "          It does not touch 1Password or the cluster; both are Scott's steps. See",
      "          docs/specs/age-key-only-secrets/plan.md for the full order.",
      "",
      "  migrate --verify",
      "          One-time, read-only. For every 1Password attachment, decrypt the matching",
      "          ciphertext and compare hashes. Reports MISMATCH and 1PASSWORD ONLY (the",
      "          orphan list) and writes a report of names and hashes, never values. Exits",
      "          0 only when both counts are zero. Never writes to 1Password and has no",
      "          delete path; deletions are done by hand in the UI after reading the report.",
      "",
      "  push, pull",
      "          Migration only. They mirror plaintext to and from 1Password, which is the",
      "          thing this change is removing. `pull` is the restore path if verify finds a",
      "          mismatch, so both stay until the attachments are deleted, then come out.",
      "",
      "Options:",
      "  --vault <name>",
      `      1Password vault to read. Default: ${DEFAULT_VAULT} (or $OP_VAULT).`,
      "",
      "  --repo-root <path>",
      "      Repo to scan. Default: the parent of this script.",
      "",
      "  --only <path|group>",
      "      Limit to one group name, directory, or file. Repeatable.",
      "",
      "  --from <path>",
      "      new only. Seed the editor session from this file, e.g. an existing",
      "      env.secret.<name>.example.",
      "",
      "  --new-recipient <age1...>",
      "      rotate-age-key only. The public key every file is re-encrypted to.",
      "",
      "  --dry-run",
      "      rotate-age-key and push. Print what would happen and write nothing.",
      "",
      "  --report <path>",
      "      migrate only. Where to write the report. Default:",
      "      .validation-outputs/migrate-verify-<date>.md (gitignored).",
      "",
      "Environment:",
      "  OP_VAULT            default vault",
      "  OP_AGE_KEY_REF      full op:// reference to the age key, overriding item lookup.",
      "                      Point it at a scratch item to test without the real key.",
      "  EDITOR              used by edit and new. Default: first of vim, nano, vi on PATH.",
    ].join("\n"),
  )
}

function main(): void {
  let values: Record<string, unknown>
  let positionals: string[]
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        vault: { type: "string" },
        "repo-root": { type: "string" },
        only: { type: "string", multiple: true },
        from: { type: "string" },
        report: { type: "string" },
        "new-recipient": { type: "string" },
        verify: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "delete-after-push": { type: "boolean", default: false },
        "delete-age-key": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        out: { type: "string" },
        help: { type: "boolean", default: false },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n`)
    usage()
    process.exitCode = 1
    return
  }

  if (values.help || positionals.length === 0) {
    usage()
    return
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const options: Options = {
    vault: (values.vault as string) ?? DEFAULT_VAULT,
    repoRoot: resolve((values["repo-root"] as string) ?? join(scriptDir, "..")),
    dryRun: values["dry-run"] === true,
    force: values.force === true,
    only: (values.only as string[]) ?? [],
    out: values.out as string | undefined,
    from: values.from as string | undefined,
    report: values.report as string | undefined,
    newRecipient: values["new-recipient"] as string | undefined,
    verify: values.verify === true,
    deleteAfterPush: values["delete-after-push"] === true,
    deleteAgeKey: values["delete-age-key"] === true,
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "op-secrets-"))
  chmodSync(tmpRoot, 0o700)
  emptyConfigHome = join(tmpRoot, "empty-config-home")
  mkdirSync(emptyConfigHome, { mode: 0o700 })
  try {
    const [command, ...rest] = positionals
    const one = (name: string): string => {
      if (rest.length !== 1) fail(`${name} takes exactly one <file> argument`)
      return rest[0]
    }
    if (command === "list") commandList(options)
    else if (command === "show") commandShow(options, one("show"))
    else if (command === "edit") commandEdit(options, one("edit"))
    else if (command === "new") commandNew(options, one("new"), tmpRoot)
    else if (command === "rotate-age-key") commandRotateAgeKey(options)
    else if (command === "migrate") commandMigrate(options)
    else if (command === "push") commandPush(options, tmpRoot)
    else if (command === "pull") commandPull(options, one("pull"), tmpRoot)
    else fail(`unknown command "${command}"`)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// Without a handler Node dies on these at once and no `finally` runs, which leaves `new`'s
// scratch file and push's decrypted copies in tmpRoot. With one, the sync child that got
// the same signal returns, the command fails or finishes, and cleanup runs before exit.
// A signal sent to this process alone cannot interrupt a sync child, so the command
// finishes first; the exit code still reports the signal.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGHUP", 129],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    process.exitCode = code
  })
}

main()
// Signal handles do not keep the event loop alive, so a signal that arrived during main()
// would never be dispatched. One more turn of the loop lets the handler set the exit code.
setImmediate(() => {})

# Back up repo plaintext secrets to 1Password (`scripts/onepassword-secrets.mts`)

## Context

This repo stores every secret twice: a SOPS+age **ciphertext** (`*.encrypted`,
committed, consumed by Flux) and the **plaintext** original (gitignored, on
Scott's laptop only). The plaintext is what you need when re-encrypting, rotating
a value, or bootstrapping a new machine — and today its only copy is one
untracked file on one disk. `home-infra-private.agekey` is worse: lose it and
every `*.encrypted` in the repo is permanently unreadable.

Scott already hand-created a 1Password item `home-infra-kubernetes secrets
authelia` holding the authelia plaintext files as attachments. This plan
automates that pattern for the whole repo, both directions, idempotently.

Inventory found by scanning (as of today):

- **38** plaintext files present on disk with an `.encrypted` sibling
- **9** with an `.encrypted` sibling but **no** local plaintext (`zot-htpasswd`,
  `zot-sync-credentials.json`, 3× `github-runners/.../.env.secret.github-token`,
  `olya-ssh.secret`, `ghcr.dockeronfigjson`, `cloudflare*credentials.json`,
  `.env.secret.alertmanager`) — these get sops-decrypted on the fly
- **6** plaintext-only orphans with no ciphertext (`scripts/.env.secret.github*`,
  `crossplane-config/.env.secret.cloudflare*`, `scripts/ghcr.dockeronfigjson`,
  `home-infra-private.agekey`)

≈53 files across ≈30 directories.

## Decisions (confirmed with Scott)

| Question | Answer |
|---|---|
| Vault | `Private` (default; `--vault` / `OP_VAULT` override) |
| Missing plaintext | sops-decrypt the `.encrypted` to a 0600 temp file, upload, unlink |
| Age key | yes — its own item `home-infra-kubernetes secrets sops-age-key` |
| Grouping | one item per **directory** containing secrets |

## New file: `scripts/onepassword-secrets.mts`

Shebang `#!/usr/bin/env -S node --experimental-strip-types`, matching
`scripts/check-persistent-mounts.mts`. Repo has no `package.json` — **node
builtins only** (`node:fs`, `node:path`, `node:child_process`, `node:crypto`,
`node:os`, `node:util`'s `parseArgs`). No bash, no npm install.

### Commands

```
./scripts/onepassword-secrets.mts list                 # inventory + per-file sync status, no values
./scripts/onepassword-secrets.mts push [--only <path|group>…] [--dry-run] [--delete-after-push]
./scripts/onepassword-secrets.mts pull <dir|group> [--force] [--out <dir>]
# global: --vault <name> (default Private), --repo-root <path>
```

### 0. Preflight: `op` must be connected

**Every** subcommand starts here, before any discovery or filesystem work, and
aborts with a clear message on failure:

1. `op --version` — CLI installed.
2. `op account list --format json` — at least one account configured. (Right now
   on this machine it is not: `op vault list` returns *"No accounts configured
   for use with 1Password CLI"*, so the desktop-app integration or
   `OP_SERVICE_ACCOUNT_TOKEN` has to be set up first.)
3. `op vault get <vault> --format json` — the target vault exists **and** the
   session is actually unlocked/authorized. This is the real check; 1 and 2 pass
   while locked.

Error text names the exact fix (turn on the desktop app integration, or
`op signin`, or set `OP_SERVICE_ACCOUNT_TOKEN`). `sops` is likewise checked with
`sops --version` before any decrypt, and the age key file's existence is checked
before decrypting (not read).

### 1. Discovery

Union of two rules, minus exclusions:

- **A** — walk repo for `**/*.encrypted`; the candidate plaintext is the path
  with `.encrypted` stripped (exists or not).
- **B** — walk for plaintext-only orphans: `.env.secret*`, `*.secret`,
  `*.agekey`, `*.dockeronfigjson`, `*credentials.json`.

Exclusions: `.git/`, `node_modules/`, `*.example`, `*.template`, `*.encrypted`,
and **anything git-tracked**. The tracked check is one `git ls-files -z` into a
`Set`; it is what keeps the committed HA stub
`apps/production/home-assistant/config-home-assistant/secrets.yaml`
(placeholder `some_password`) out, and it loudly warns if a real plaintext
secret ever gets committed.

### 2. Grouping → item title

`groupFor(dir)`: strip leading `apps/production/`, `apps/base/`,
`infrastructure/prod/`, `infrastructure/base/`, then drop `configs/` and
`controllers/` segments, then join remaining segments with `-`. A small explicit
`GROUP_OVERRIDES` map handles the awkward ones rather than inventing clever
rules:

```ts
const GROUP_OVERRIDES: Record<string, string> = {
  ".": "sops-age-key",                                        // home-infra-private.agekey
  "apps/base/photoprism": "photoprism-base",
  "apps/production/github-runners/runners/fernfiles": "github-runners-fernfiles",
  // …ramblefeed, tinkerbell
}
```

Title = `home-infra-kubernetes secrets <group>` — matches the existing authelia
item exactly. After building the map, **error on any two directories resolving
to the same group**.

### 3. Item shape

- Category: match the existing authelia item (read it with `op item get
  "home-infra-kubernetes secrets authelia" --format json | jq '{category}'`
  during implementation; expect `SECURE_NOTE`).
- Tag `home-infra-k8s-flux` on every item so `op item list --tags` finds them.
- Text field `repo_path` = repo-relative directory, so a human reading the item
  in the 1Password UI knows where the files belong.
- One **file attachment per secret file**, field label = the file's basename.
  `pull` reconstructs the path as `repo_path + "/" + label`, so no extra
  bookkeeping field is needed.

### 4. `op` invocation details (the sharp edges)

- Attachments use assignment statements: `'<label>[file]=<abs path>'` on `op item
  create` / `op item edit`. **Dots are section separators in that syntax**, so
  every `.`, `=`, and `\` in the label must be backslash-escaped —
  `.env.secret.app` → `\.env\.secret\.app[file]=…`. This is the single most
  likely thing to get wrong.
- Read back for comparison: `op read --out-file <tmp> "op://Private/<title>/<label>"`.
- Replace-in-place: first try re-assigning the same label via `op item edit`;
  immediately re-`get` the item and assert exactly one file with that name. If
  `op` duplicates instead of replacing, fall back to `op item edit <id>
  '<label>[delete]='` then re-add. Verify this on one item before running a
  full push.
- Never pass secret *values* as argv (visible in `ps`) — only file paths.

### 5. sops decrypt (for the 9 missing-plaintext files)

Three envelope formats exist in this repo; detect per file:

| Detection | `--input-type`/`--output-type` |
|---|---|
| basename matches `.env*` / `env.secret*` | `dotenv` |
| JSON whose non-`sops` keys are exactly `["data"]` | `binary` |
| any other JSON | `json` |

Reuse the existing key location from `scripts/_sops_config.include.sh`:
`SOPS_AGE_KEY_FILE=<repo root>/home-infra-private.agekey`, set in the child
env. Capture stdout to a Buffer, write to a 0600 file inside an
`fs.mkdtempSync` 0700 dir, `rm -rf` the dir in a `finally`. **Never log that
buffer** — on failure surface only the child's stderr.

### 6. Idempotency

Per file: compute local `sha256`. Fetch the current attachment to a temp file,
hash it, compare. Classify `new` / `changed` / `unchanged`, and only call `op
item edit` for the first two. `--dry-run` prints the classification table and
exits. Output is counts and file names only — never a value, never a diff.

### 7. `--delete-after-push`

Opt-in. After a file is pushed, delete the local plaintext — but only on proof
the upload survived, since this is the irreversible step:

1. Upload the attachment.
2. Re-fetch it with `op read --out-file` into the temp dir and confirm its
   `sha256` equals the local file's hash. Confirming the `op` command exited 0
   is **not** sufficient — the read-back is the gate.
3. **Unlink that read-back temp file immediately**, as soon as its hash is
   computed and compared — before touching the real file. It is a second
   plaintext copy of the secret sitting on disk, so it must not outlive the
   comparison. The enclosing 0700 `mkdtemp` dir is still `rm -rf`'d in the
   run's `finally` as a backstop, but the per-file unlink is explicit and does
   not wait for it: a crash mid-run must not leave a readable copy behind.
4. Only then `fs.unlinkSync` the local plaintext. A file classified `unchanged`
   is also eligible (its content is already verified present in 1Password), and
   it goes through the same fetch → hash → unlink-temp → unlink-local sequence.
5. Any hash mismatch, any non-zero exit: unlink the temp file anyway, leave the
   local plaintext alone, and report it.

Guards:

- `*.agekey` is **never** deleted by this flag — dropping
  `home-infra-private.agekey` breaks every local `sops` operation, including
  this script's own decrypt path. Deleting it needs the separate explicit
  `--delete-age-key`.
- Files that were sops-decrypted to a temp file (no local plaintext to begin
  with) are unaffected; the temp dir is removed regardless.
- `--dry-run` lists exactly which paths *would* be deleted and deletes nothing.
- The run prints a final count of deleted paths.

Note the consequence: for a file with an `.encrypted` sibling, deleting the
plaintext means the only plaintext copy is now in 1Password — which is the point
(it is what the `create-*.sh` scripts already do), but it makes `pull` the only
way back.

### 8. `pull`

Accepts either a directory (`apps/production/authelia`) or a group
(`authelia`), resolves the item, and `op read --out-file`s each attachment to
`repo_path/<label>` with mode `0600`. Refuses to overwrite an existing file
unless `--force`; `--out <dir>` redirects to a scratch directory for
verification without touching the working tree.

## Also update

- `README.md` "Secrets" section (currently line ~175): document the backup
  workflow and the two commands, next to the existing SOPS instructions.
- `docs/specs/onepassword-secret-backup/plan.md` + `summary.md` — spec docs are
  committed in this repo (`docs/specs/*/plan.md` are tracked), and it uses plain
  names, not `NNN-` prefixes. Add a `docs/specs/handoff.md` line while in flight.

## Verification

0. Preflight: with `op` signed out, every subcommand must fail fast with the
   actionable message and touch nothing. Then sign in and re-run.
1. `./scripts/onepassword-secrets.mts list` — confirm ≈53 files / ≈30 groups,
   no group collisions, `home-assistant/.../secrets.yaml` absent,
   `scripts/create-zot-htpasswd.sh` absent.
2. `push --dry-run` — every file should classify `new` except the authelia ones
   already uploaded by hand, which must classify `unchanged` (that is the real
   proof the hashing and read-back path work).
3. `push --only apps/production/authelia` — re-run; second run must report all
   `unchanged` and issue zero `op item edit` calls. Confirm in the 1Password UI
   that no duplicate attachments appeared.
4. Full `push`. Then `pull apps/production/tayle --out <scratch>` and
   `diff -r` against the real directory — expect no differences.
5. Sanity-check one decrypt-on-the-fly file end-to-end: `pull apps/production/zot
   --out <scratch>`, then `sops encrypt` the pulled `zot-htpasswd` and confirm
   `sops -d` of the repo's committed ciphertext matches it byte-for-byte
   (compare hashes, do not print).
6. `push --delete-after-push --dry-run` — inspect the would-delete list; confirm
   `home-infra-private.agekey` is not on it. Then exercise it for real on one
   throwaway-safe group only (e.g. `apps/production/transmission`), confirm the
   plaintext is gone and `pull` restores it byte-identical.
7. `git status` must be clean afterward apart from the new script and docs — no
   temp files, no plaintext left behind.

## Out of scope

- No changes to `encrypt-env-files.sh` or the `create-*.sh` scripts.
- No re-encryption or rotation; this script only moves plaintext between disk
  and 1Password.

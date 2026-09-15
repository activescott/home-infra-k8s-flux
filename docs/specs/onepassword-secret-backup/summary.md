# Summary — 1Password backup of repo plaintext secrets

Implements the plan in [plan.md](plan.md). Delivered `scripts/onepassword-secrets.mts`
(825 lines), plus a "Backing plaintext up to 1Password" subsection in the README's
Secrets section (+38 lines).

## Quick commands to resume work

```bash
cd /Users/scott/src/activescott/home-infra-k8s-flux

./scripts/onepassword-secrets.mts list --offline      # inventory, no 1Password calls
./scripts/onepassword-secrets.mts list                # adds attached/missing per file
./scripts/onepassword-secrets.mts push --dry-run      # classify everything
./scripts/onepassword-secrets.mts push --only tayle   # upload one group
./scripts/onepassword-secrets.mts pull tayle --out /tmp/check
```

## Current state

- Script written and exercised end-to-end.
- **Full push done**: `list` reports all 31 groups as `item exists` and all 56
  files as `attached` — `🟢 every file is backed up in Private`.
- The hand-created `home-infra kubernetes secrets authelia` item classifies
  `unchanged`, which is the proof that hashing + read-back agree with a file
  uploaded through the 1Password UI.
- `--delete-after-push` has been run across the repo: **no local plaintext
  remains**, and `push` now works entirely from ciphertext + 1Password. Six
  orphan files (no `.encrypted` sibling) now exist only in 1Password — see
  "Deleting plaintext can drop a file out of discovery entirely" below.
- The age key is still on disk; it needs `--delete-age-key` to be removed and
  that has deliberately not been used.

## What the repo actually contains

`list --offline` finds **56 secret files across 31 groups**; **10** have no local
plaintext and are sops-decrypted on the fly.

## Non-obvious things discovered

- **The item title has no hyphen before "kubernetes".** The existing items are
  `home-infra kubernetes secrets <group>`, not `home-infra-kubernetes secrets …`.
  Getting this wrong silently creates a parallel set of duplicate items.
- **A legacy monolithic item exists**, titled exactly `home-infra kubernetes secrets`
  (no group suffix), holding 26 attachments organised by *section* (General,
  Ramblefeed, Monitoring, GPUPoet, …) with duplicate filenames across sections. The
  script never reads or writes it — `ITEM_TITLE_PREFIX` has a trailing space, so the
  bare title doesn't match. Scott deletes it by hand once everything is onboarded.
- **`op item edit '<label>[file]=<path>'` replaces in place**; it does not append a
  second attachment. Verified on a scratch item (size went 30 → 40 bytes, one
  attachment). The delete-then-re-add fallback in `attachFile()` is therefore dead
  code in practice, kept as a guard in case `op` behaviour changes.
- **Periods in an `op` assignment statement separate section from field**, so every
  `.env.secret.app`-style label must be escaped to `\.env\.secret\.app`. This is the
  thing most likely to break if the script is rewritten.
- **Three sops envelope formats are in play** and the flags are not interchangeable:
  dotenv for `.env*`, `binary` for `{"data": "ENC[…]"}` (zot-htpasswd, olya-ssh.secret),
  `json` for everything else (ghcr.dockeronfigjson, cloudflare*credentials.json).
  `sopsFormat()` detects by filename then by JSON shape.
- **`process.exit()` skips `finally` blocks.** The script throws `CliError` instead,
  so the 0700 `mkdtemp` directory holding decrypted plaintext is always removed.

## The sops dotenv round-trip drops blank lines

The single most surprising behaviour here. Once `--delete-after-push` removes a
file's local plaintext, `push` has nothing authoritative left to compare against
1Password, so it falls back to `sops decrypt` of the `.encrypted` sibling. That
round-trip is **not** byte-identical to the original: comments, quoting, spacing
inside values and key order all survive, but **blank lines are discarded**.

Measured on a synthetic dotenv file, encrypted and decrypted with this repo's exact
flags:

```
orig 178 bytes 9 lines
rt   176 bytes 7 lines
diff (line ends marked $):
  3d2
  < $
  8d6
  < $
identical after stripping blank lines? YES
```

It is not sops metadata. The keys sops appends to a dotenv ciphertext —
`sops_lastmodified`, `sops_mac`, `sops_unencrypted_suffix`, `sops_version` — exist
only in the ciphertext and are already removed by decrypt.

Consequence before the fix: every dotenv secret that had a blank line reported
`changed` on every run and each push overwrote the pristine stored original with the
normalized reconstruction. That happened once for real — a `push --delete-after-push`
reported "19 replaced" for files nobody had touched. No secret *value* was altered;
only blank lines were lost from the 1Password copies. 1Password keeps per-item version
history if an original is ever needed back.

Fix: `hashesOf()` computes both a raw sha256 and one with blank lines stripped, and
`classify()` accepts the normalized match **only** when the local side came from a
*dotenv* decrypt. A real local plaintext, or a binary/json decrypt, still treats any
byte difference as `changed`. Matches that needed the tolerance print
`(matched ignoring blank lines)` and are counted in the run summary, so it is never
silent.

Verified three ways against a scratch repo: original-with-blank-lines pushed then
plaintext deleted → `unchanged (matched ignoring blank lines)`; a rotated value in the
ciphertext → still `changed`; tolerance never applied outside dotenv decrypts.

## Deleting plaintext can drop a file out of discovery entirely

Discovery is disk-driven: a candidate comes either from an `.encrypted` file or from a
plaintext-only orphan pattern. For the orphans — files with **no** ciphertext sibling —
`--delete-after-push` leaves nothing on disk at all, so they silently disappear from
`list` and `push` while the footer still says `🟢 every file is backed up`. The count
went 56 files / 31 groups → 50 / 30 without comment. `pull` still works for them
(it resolves from 1Password), but nothing tells you they exist.

The six affected, and what they were:

| File | Status |
|---|---|
| `scripts/.env.secret.github` | zero references anywhere in the repo; dead |
| `scripts/.env.secret.github.flux-bootstrap` | still read by `scripts/flux-bootstrap.sh:8` and `scripts/update-flux-image-scanning-webhooks/manage-webhooks.ts:152` as the `GITHUB_TOKEN` fallback |
| `scripts/ghcr.dockeronfigjson` | transient working file — `create-image-pull-secret-ghcr.sh:39` writes, encrypts, deletes it |
| `crossplane-config/.env.secret.cloudflare` | hand-pasted token *input* to `create-cloudflare-credentials.sh`; only the `{api_token}` JSON derivative was ever encrypted |
| `crossplane-config/.env.secret.cloudflare-email` | same |
| `olya/.env.secret.olya-basic-auth` | no longer needed; its attachment was deleted from the `olya` item |

Still open: making `list` enumerate the vault as well as the disk, so 1Password-only
files are visible instead of merely absent.

Noticed while tracing the above: `create-image-pull-secret-ghcr.sh:54` writes its
ciphertext to `apps/production/shared/ghcr-pull-secret/`, but the only such file on
disk is at `infrastructure/prod/configs/ghcr-pull-secret/` — that path looks stale.

## Bug found and fixed during verification

`pull` originally resolved its target by scanning the working tree. After
`--delete-after-push` removed a plaintext file that had no `.encrypted` sibling
(the age key, `scripts/.env.secret.github*`, the crossplane cloudflare tokens),
there was nothing left on disk to discover, so pull refused to restore exactly the
files that most needed restoring. `resolvePullTarget()` now resolves against
1Password — by group name, falling back to matching the item's `repo_path` field.

Reproduced and fixed with a throwaway git repo under the scratchpad plus a dummy
`FAKE_TOKEN=not-a-real-secret` file, pushed to a `…secrets faketest` item that was
deleted afterwards. That harness is the cheapest way to exercise replace and
`--delete-after-push` without touching a real secret; recreate it if you change
either path.

## Verified

| Check | Result |
|---|---|
| `list --offline` inventory | 56 files, 31 groups, no group-name collisions |
| Exclusions | committed HA `secrets.yaml` stub, `*.example`, `*.template`, `*.encrypted` all absent |
| Hash/read-back vs a UI-uploaded item | authelia's 2 files → `unchanged` |
| sops decrypt, all 3 formats | zot (binary+json), ghcr (json), github-runners (dotenv) all classify `new` with no sops error |
| Item creation | `transmission` item: SECURE_NOTE, tag `home-infra-k8s-flux`, `repo_path` field, dotted filename intact |
| Idempotency | second push of `transmission` → `unchanged`, zero writes |
| Replace | edited scratch file → `changed`, exactly 1 attachment afterwards |
| `--delete-after-push` | dry-run lists the path; real run deleted only after hash match |
| Round-trip | pull after delete restored byte-identical content, mode 0600 |
| Real-repo round-trip | `pull transmission --out <scratch>` diffs identical |

## Remaining / next

- Spot-check a few items in the 1Password UI, then delete the legacy monolithic
  `home-infra kubernetes secrets` item (26 attachments, sectioned by app). The
  script never touches it: `ITEM_TITLE_PREFIX` has a trailing space, so the bare
  title never matches.
- `--delete-after-push` has not been run against any real repo secret. Doing so
  makes 1Password the only plaintext copy; `pull` is then the only way back.
- Re-run `list` after any new app lands a secret — the footer says
  `🟢 every file is backed up` or `🟡 N file(s) not yet in <vault> — run push`.

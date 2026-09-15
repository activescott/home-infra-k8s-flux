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
- Pushed for real so far: **`transmission` only** (1 file). Everything else is
  still unpushed — `push --dry-run` reports them as `new`.
- The hand-created `home-infra kubernetes secrets authelia` item classifies
  `unchanged`, which is the proof that hashing + read-back agree with a file
  uploaded through the 1Password UI.

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

- Run the full `push` (55 remaining files, ~30 new items).
- After that, spot-check a few items in the 1Password UI and delete the legacy
  monolithic `home-infra kubernetes secrets` item.
- `--delete-after-push` has not been run against any real repo secret. Doing so
  makes 1Password the only plaintext copy; `pull` is then the only way back.

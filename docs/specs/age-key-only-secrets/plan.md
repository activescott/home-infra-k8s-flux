# Keep only the age key in 1Password; decrypt secrets from git

Plan for [#159](https://github.com/activescott/home-infra-k8s-flux/issues/159).
Deliverable 1 is this document. Implementation follows Scott's approval.

## Goal

The SOPS ciphertext in git becomes the only copy of every secret. 1Password holds
one thing: the age private key. `scripts/onepassword-secrets.mts` stops mirroring
plaintext and becomes the tool that reads the key from 1Password into memory and
uses it to show, edit, create and re-encrypt files in place.

Two copies of a secret drift, and on 2026-09-17 they did: the relay secret was
encrypted before its plaintext was saved, and the 1Password push then reported it
"unchanged". One copy cannot drift.

## What is true today

`./scripts/onepassword-secrets.mts list --offline` on a clean checkout of
`main` (2026-09-18):

```
54 secret file(s) in 30 group(s); 52 need sops decryption (no local plaintext);
2 public-key encrypted, nothing to back up
```

Every one of those 54 has a committed `.encrypted` sibling, and no plaintext
exists anywhere in the checkout. The age key is not in the checkout either.

That count is not the whole inventory, and this is the single most important fact
for the migration. Discovery is driven by what is on disk: a candidate comes
either from an `*.encrypted` file or from a plaintext-only orphan pattern
(`ORPHAN_PATTERNS`, `onepassword-secrets.mts:66`). A plaintext-only file whose
local copy was deleted by `push --delete-after-push` leaves nothing on disk, so
it drops out of `list` entirely while the footer still reports everything backed
up. `docs/specs/onepassword-secret-backup/summary.md:107` records this happening:
the count went 56 files / 31 groups to 50 / 30 with no comment.

So the orphan set is exactly the set that `list` cannot see, and the only way to
enumerate it is to read the vault. That is what `migrate --verify` is for.

## Decisions

| Question | Answer |
|---|---|
| Where the age key lives | 1Password only, item `home-infra kubernetes secrets sops-age-key`, vault `Private` (or `$OP_VAULT`), file attachment `home-infra-private.agekey` |
| How the script gets it | `op read` into `SOPS_AGE_KEY` in the child process env, once per run, never to disk |
| Re-encrypt mechanism for rotation | `sops rotate -i --add-age <new> --rm-age <old>`, not `sops updatekeys` (see below) |
| Recipient of record | `age_key_public` in `scripts/_sops_config.include.sh`, unchanged as the single declaration |
| Old age keys | never destroyed; every commit in this repo's history is encrypted to them |
| Deleting 1Password attachments | by hand, in the UI, after `migrate --verify` exits 0 and Scott has read the report. No delete path in any script |

### Why `sops rotate` and not `sops updatekeys`

The issue says `sops updatekeys`. `updatekeys` reads the desired recipient list
from `.sops.yaml` creation rules, and this repo has no `.sops.yaml`: the recipient
is passed explicitly as `--age "$age_key_public"` by every encrypting script. Adding
a `.sops.yaml` would put the recipient in a second place that can drift from
`_sops_config.include.sh`, which is the class of problem this issue exists to remove.

`sops rotate -i --add-age <new> --rm-age <old> --input-type <fmt> --output-type <fmt>`
needs no config file, takes the recipients as arguments, and additionally mints a
fresh data key rather than re-wrapping the old one. Same outcome for the file, one
less thing to keep in sync.

## Reading the age key

```
op://<vault>/<item id>/home-infra-private.agekey
```

The item title contains spaces, so the script resolves it to an id first, reusing
`listItemsByTitle()`, and builds the `op://` reference from the id. `op` is spawned
with an argv array and no shell, so the spaces cause no quoting problem either way,
but a renamed item then fails with a clear message instead of a path parse error.
`$OP_AGE_KEY_REF` overrides the whole reference for testing against a scratch item.

```ts
const key = op(["read", `op://${vault}/${itemId}/${AGE_KEY_FILENAME}`])
if (key.status !== 0) fail(...)            // stderr only, never stdout
const env = { ...process.env, SOPS_AGE_KEY: key.stdout.toString("utf8").trim() }
delete env.SOPS_AGE_KEY_FILE               // sops merges it with SOPS_AGE_KEY
delete env.SOPS_AGE_KEY_CMD
```

Other identity sources are the trap here. sops merges identities from
`SOPS_AGE_KEY_FILE`, `SOPS_AGE_KEY`, `SOPS_AGE_KEY_CMD` and its default `keys.txt`
(https://getsops.io/docs/usage/identities/age/). A stale `SOPS_AGE_KEY_FILE`
exported in Scott's shell, a leftover `home-infra-private.agekey`, or a key in
`~/.config/sops/age/keys.txt` would make decrypts succeed and hide the fact that the
1Password path is broken. The variables are deleted from the child env and
`XDG_CONFIG_HOME` points at an empty directory.

The value is read once per run and cached in a module-level variable, so 1Password
prompts once no matter how many files a command touches. It is never logged, never
written, never passed as argv. `requireSops()` loses its key-file lookup entirely.

Commands that need the private key: `show`, `edit`, `rotate-age-key`,
`migrate --verify`. Commands that do not: `list`, `new` (encryption only needs the
public recipient).

`scripts/_sops_config.include.sh` drops the `SOPS_AGE_KEY_FILE` assignment and the
existence check, keeping only `age_key_public`. Every shell script that sources it
(`encrypt-env-files.sh`, `create-cloudflare-credentials.sh`,
`create-zot-sync-credentials.sh`, `create-olya-ssh-secret.sh`,
`apps/production/zot/scripts/create-zot-htpasswd.sh`) encrypts to the public
recipient only, so all of them keep working with no key present. That is already
true in practice; removing the check is what makes it true on a machine with no
key file.

## Command surface

```
./scripts/onepassword-secrets.mts list [--only <path|group>]...
./scripts/onepassword-secrets.mts show <file>
./scripts/onepassword-secrets.mts edit <file>
./scripts/onepassword-secrets.mts new <file> [--from <example|template>]
./scripts/onepassword-secrets.mts rotate-age-key --new-recipient <age1...> [--dry-run]
./scripts/onepassword-secrets.mts migrate --verify [--only <group>] [--report <path>]
```

Global flags: `--vault <name>`, `--repo-root <path>`. `<file>` accepts either side
of the pair (`.env.secret.db` or `.env.secret.db.encrypted`); both resolve to the
same file.

### `list`

Reads git, not 1Password, so `--offline` disappears. For each `*.encrypted` file it
prints the group, the sops format detected by `sopsFormat()`, and the recipient
parsed out of the file itself (`sops_age__list_0__map_recipient=` for dotenv,
`.sops.age[].recipient` for json/binary). Two conditions are red:

- the recipient does not match `age_key_public`, which means a rotation did not
  finish and this file is readable only with a retired key
- a plaintext sibling exists on disk, which after this change is a mistake rather
  than something to back up

`ORPHAN_PATTERNS` survives for exactly that second check. Exit code is 1 if either
condition is found anywhere, so the command is usable as a post-rotation gate.

### `show <file>`

`sops decrypt` with the detected input and output type, straight to stdout. Nothing
is written. This replaces every `pull` in the READMEs and every hand-written
`SOPS_AGE_KEY_FILE=... sops decrypt` block.

### `edit <file>`

`sops edit --input-type <fmt> --output-type <fmt> <file>.encrypted` with
`stdio: "inherit"` so `$EDITOR` gets the terminal. sops decrypts to a temp file in
its own 0700 directory, re-encrypts on save, and removes it. `SOPS_EDITOR` wraps the
editor in `env -u SOPS_AGE_KEY` so the editor never holds the key. The plaintext never exists at
a repo path and never exists after the editor exits. Re-encryption keeps the
file's existing recipients, so an edit during a half-finished rotation does not
silently move a file back to the old key.

### `new <file>`

For a secret that does not exist yet. Creates a 0600 file inside a 0700
`mkdtempSync` directory, seeded from `--from <example>` if given (the repo has
`env.secret.*.example` and `*.template` files for several apps), opens `$EDITOR` on
it, then:

```
sops encrypt --age "$age_key_public" --input-type dotenv --output-type dotenv \
  --filename-override <repo-relative target> <tmp> > <file>.encrypted.tmp.$$
mv <file>.encrypted.tmp.$$ <file>.encrypted
```

Temp file unlinked and the directory `rm -rf`'d in a `finally`, same pattern as the
current push path. `--filename-override` makes sops see the destination name for
format detection. Writing to a temp file and moving is the same reason
`encrypt-env-files.sh:33` does it: redirecting into the target truncates it before
sops runs, and for a file whose only copy is the ciphertext that destroys it.

Needs no private key.

### `rotate-age-key --new-recipient <age1...>`

Does the repo-side half of a rotation. It does not touch 1Password or the cluster:
both need Scott. Preconditions, all checked before anything is written:

1. `op` reachable and the vault readable (existing `preflight()`).
2. Working tree clean, current branch is not `main`.
3. The new recipient is syntactically valid (`age -r "$new" -o /dev/null </dev/null`,
   the same check `create-olya-hook-token.sh:65` uses).
4. **1Password already holds the new private key.** The script encrypts a scratch
   value to `--new-recipient` and decrypts it with the key read from 1Password. If
   that round trip fails, the new key is not stored yet and nothing is re-encrypted.
   This is the gate that makes the whole procedure safe: ciphertext is never moved
   to a key that exists in only one place.

Then, per discovered `*.encrypted` file:

```
sops rotate -i --add-age <new> --rm-age <old> \
  --input-type <fmt> --output-type <fmt> <path>
```

with `SOPS_AGE_KEY` in the env. Old recipient comes from the file, so a file already
rotated is a no-op rather than an error. Summary table of file, format, ok or failed.
On any failure it stops, prints the failed path and `git checkout -- .` as the
rollback, and leaves the rest alone: the tree was clean at the start, so that
command restores it exactly.

Finally it rewrites `age_key_public` in `scripts/_sops_config.include.sh` and prints
the remaining manual steps. `--dry-run` prints the file list and the recipient
change and writes nothing.

## Rotation order, and what happens to Flux

The issue's order is new key, re-encrypt, recipient in `_sops_config.include.sh`,
in-cluster secret, 1Password item. That order has a real outage window: between the
merge of the re-encrypted files and the update of the `sops-age` secret, the cluster
holds only the old key and cannot decrypt anything it is being asked to apply.

kustomize-controller imports **every** data entry in the decryption secret whose key
ends in `.agekey` and tries each identity, so the window is avoidable. Put both keys
in the cluster before any ciphertext changes:

| # | Step | Who | Rollback |
|---|---|---|---|
| 1 | `age-keygen -o <path on an encrypted volume>` | Scott | delete the file, nothing else exists yet |
| 2 | Upload it to 1Password as a **second** attachment on `home-infra kubernetes secrets sops-age-key`, named `home-infra-private-<YYYYMMDD>.agekey`. Leave the current `home-infra-private.agekey` attachment alone | Scott | delete the attachment |
| 3 | Make the offline copy (see below) and verify `age-keygen -y` on it prints the new public key | Scott | redo |
| 4 | Add the new key to the in-cluster secret **alongside** the old one, two `.agekey` data entries | Scott | re-apply the secret with the old key only |
| 5 | `rotate-age-key --new-recipient <new>` on a branch, review `git diff --stat`, commit, PR, merge | agent or Scott | `git checkout -- .` before commit; `git revert` after merge, which restores ciphertext the still-present old key decrypts |
| 6 | Confirm Flux is green: `flux --context nas get kustomization apps`, `kubectl --context nas get kustomizations -A` | either | step 5's revert |
| 7 | Re-apply the in-cluster secret with the new key only, naming it: `create-sops-age-decryption-secret.sh home-infra-private-<YYYYMMDD>.agekey`. With no argument it would apply both, since the old one is not renamed until step 8 | Scott | re-add the old entry |
| 8 | In 1Password, rename the old attachment to `home-infra-private-retired-<YYYYMMDD>.agekey` and the new one to `home-infra-private.agekey` | Scott | rename back |

Steps 4 and 7 are `kubectl` against the cluster, which AGENTS.md otherwise forbids.
The `sops-age` secret is the one thing that cannot be in git, since it is what
decrypts git, and `scripts/create-sops-age-decryption-secret.sh` already exists for
exactly this. That script changes to read the key or keys from 1Password and build
the Secret in a pipe:

```bash
kubectl --context nas apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata: { name: sops-age, namespace: flux-system }
data:
  home-infra-private.agekey: $(op read "op://..." | base64)
  home-infra-private-20260918.agekey: $(op read "op://..." | base64)
EOF
```

No key file, no argv exposure, no temp file. It keeps the existing non-empty
read-back check.

If Flux does end up unable to decrypt, the failure is visible and bounded: the
Kustomization goes NotReady with `failed to decrypt sops data`, and nothing new is
applied. Secrets already in the cluster keep their values, because Flux does not
prune or blank a resource on a failed reconcile. Running workloads survive; new
deploys do not happen until a key that can read the ciphertext is in the secret.

Never delete a retired key from 1Password. Every `*.encrypted` blob in this repo's
git history is encrypted to whichever key was current at the time, and a `git revert`
or an archaeology dig into an old commit needs it.

## `migrate --verify`

One-time, read-only, the gate in front of every deletion from 1Password.

It enumerates the **vault**, not the disk: every item titled
`home-infra kubernetes secrets *` (never the legacy monolithic
`home-infra kubernetes secrets` item, which has no group suffix and which
`ITEM_TITLE_PREFIX`'s trailing space already excludes). For each file attachment:

1. `op read --no-newline` to stdout, hash it raw and with blank lines stripped.
   Nothing is written to disk. Same `hashAttachment()` the push path uses.
2. Find the ciphertext at `<repo_path>/<attachment name>.encrypted`.
3. If it exists, decrypt it with the key from 1Password and hash the result the same
   two ways.

Verdicts:

| Verdict | Meaning |
|---|---|
| `match` | raw hashes equal |
| `match (blank lines only)` | normalized hashes equal, dotenv decrypt only. The sops dotenv round trip discards blank lines and nothing else, measured in `onepassword-secret-backup/summary.md:63` |
| `MISMATCH` | both differ. Reports the key names present on each side and which keys' values differ. Names only, never values, never a content diff |
| `1PASSWORD ONLY` | no ciphertext at that path. This is the orphan list |
| `GIT ONLY` | ciphertext with no attachment. Informational |

Output is a table on stdout and a written report at
`.validation-outputs/migrate-verify-<date>.md` (`.validation-outputs/` is gitignored
by `.gitignore:26`), overridable with `--report`. The report has file names, groups,
verdicts and hashes, so it is safe to read and to keep, and it is what Scott reads
before deleting anything.

Exit code is 0 only when there are zero `MISMATCH` and zero `1PASSWORD ONLY`. That
makes "clean" a thing the shell can check rather than a judgement call.

`migrate` never writes to 1Password and has no delete flag. Deleting is done by hand
in the 1Password UI, item by item. Writing a delete path is how a verification tool
becomes a data-loss tool, and 1Password's own version history is the undo for a
mistake made in the UI.

`migrate` is removed in a follow-up PR once the vault is down to the age key item.

## Orphan inventory and destinations

`list --offline` reports **zero** orphans today, for the reason in "What is true
today": their local copies are gone, so disk-driven discovery cannot see them. The
authoritative list comes from `migrate --verify`. The table below is what is known
from `docs/specs/onepassword-secret-backup/summary.md:116` plus the scripts that
still write plaintext, and it is what the verify run is expected to confirm.

| 1Password attachment | Item group | What it is | Destination |
|---|---|---|---|
| `home-infra-private.agekey` | `sops-age-key` | the age private key | **Stays in 1Password.** It is what decrypts git, so it cannot live in git |
| `scripts/.env.secret.github.flux-bootstrap` | `scripts` | GitHub PAT, read as the `GITHUB_TOKEN` fallback by `scripts/flux-bootstrap.sh:8` and `scripts/update-flux-image-scanning-webhooks/manage-webhooks.ts:152` | **Encrypt into git** as `scripts/.env.secret.flux-bootstrap.encrypted`; both consumers read it through `show`. Adds no new dependency: bootstrap already needs the age key to create the `sops-age` secret |
| `scripts/.env.secret.github` | `scripts` | second PAT, zero references anywhere in the repo | **Revoke on GitHub, then delete.** An unreferenced credential is a liability, not a backup. Revoking matters more than deleting |
| `scripts/ghcr.dockeronfigjson` | `scripts` | transient working file of `create-image-pull-secret-ghcr.sh:39` | **Delete.** The real secret is `infrastructure/prod/configs/ghcr-pull-secret/ghcr.dockeronfigjson.encrypted`, in git. Fix that script to write its temp file into a `mktemp -d` and delete it, and fix its stale output path (`create-image-pull-secret-ghcr.sh:54` writes to `apps/production/shared/ghcr-pull-secret/`, which does not exist) |
| `crossplane-config/.env.secret.cloudflare` | `crossplane-config` | hand-pasted raw Cloudflare API token, the *input* to `create-cloudflare-credentials.sh` | **Delete after a derived-value check.** The same token is already in git inside `cloudflare-credentials.json.encrypted`; encrypting the dotenv form too would recreate the two-copies problem. Change the script to read the token from `$EDITOR` in a temp dir instead of a `.env.secret.*` file |
| `crossplane-config/.env.secret.cloudflare-email` | `crossplane-config` | same, for the Email Sending token | same |
| `zot/.env.secret.zot-passwords` | `zot` | plaintext ci and mirror registry passwords. Not derivable from the committed bcrypt hashes | **Encrypt into git** as `apps/production/zot/.env.secret.zot-passwords.encrypted`. `create-zot-htpasswd.sh:25` writes this file specifically so `push` picks it up; it changes to encrypt in place and delete the plaintext |
| `olya/.env.secret.olya-basic-auth` | `olya` | obsolete; the attachment was already deleted | none; verify should not find it |

Derived-value check for the two Cloudflare tokens, which verify cannot do
automatically because the dotenv and JSON forms are different bytes. Hashes only,
no value reaches the terminal:

```bash
./scripts/onepassword-secrets.mts show \
  infrastructure/prod/controllers/crossplane-config/cloudflare-credentials.json \
  | jq -r .api_token | shasum -a 256
op read "op://Private/home-infra kubernetes secrets crossplane-config/.env.secret.cloudflare" \
  | sed -n 's/^CLOUDFLARE_API_TOKEN=//p' | shasum -a 256
# the two hashes must match
```

Anything `migrate --verify` turns up that is not in this table gets a decision from
Scott before anything is deleted.

## Removing `push` and `pull`

Deleted along with them: `--delete-after-push`, `--delete-age-key`, `--force`,
`--out`, `--dry-run` in its push sense, `--offline`, and the code that exists only
for them (`classify`, `pushGroup`, `attachFile`, `createItem`,
`ensureRepoPathField`, `resolvePullTarget`, `assertSafeDestination`,
`assertGitIgnored`, `escapeFieldName`, `PushEntry`, `PushCounts`).

`hashAttachment`, `stripBlankLines`, `hashesOf`, `repoPathOf` and `listItemsByTitle`
stay until `migrate` is removed, since verify needs all of them.

Ordering matters: `push` and `pull` come out **after** `migrate --verify` is clean
and the attachments are deleted, not before. Until then `pull` is the restore path
if verify finds a mismatch, and removing it early removes the only way back.

### Dropping `.public-key-encrypted`

Once nothing has a plaintext copy, the suffix distinguishes nothing.

```bash
git mv apps/production/monitoring/prometheus/.env.secret.alertmanager-olya-hook.public-key-encrypted.encrypted \
       apps/production/monitoring/prometheus/.env.secret.alertmanager-olya-hook.encrypted
git mv apps/production/olya/.env.secret.olya-hooks.public-key-encrypted.encrypted \
       apps/production/olya/.env.secret.olya-hooks.encrypted
```

Both renames and both `secretGenerator` references go in **one commit**:
`apps/production/monitoring/prometheus/kustomization.yaml:47` and
`apps/production/olya/kustomization.yaml:67`. A `secretGenerator` pointing at a
missing file fails the whole kustomization build, which takes those namespaces'
reconcile down, not just the one Secret.

No workload restarts. `alertmanager-olya-hook` sets `disableNameSuffixHash: true`,
and `olya-hooks` is content-hashed, so identical content gives an identical Secret
name either way.

`PUBLIC_KEY_ENCRYPTED_SUFFIX`, `SecretFile.publicKeyEncrypted` and the "n/a" column
in `list` all come out.

### `scripts/create-olya-hook-token.sh`

Three changes, no behaviour change:

- `alertmanager_file` and `olya_file` (lines 25 and 26) point at the renamed paths.
- The comment at lines 23 to 24 explaining the `.public-key-encrypted` marker goes
  away.
- The comment at lines 42 to 44 says the recipient comes from the files rather than
  from `_sops_config.include.sh` "which refuses to run without the private key file".
  That include no longer refuses, so the reason becomes the better one: the files are
  the authority on who can already read them, and a rotation half-applied shows up
  here as a recipient mismatch between the two files, which the script already
  rejects.

It still needs no private key, which is worth keeping true: it is the one rotation an
agent can do end to end.

## Offline second copy (Scott, by hand)

Losing the age key loses every secret in this repo. 1Password is one account with one
recovery path, so the key needs a copy that does not depend on it.

At initial adoption and at every rotation, after step 2 above:

1. Write the key to a second medium that is not the laptop and not 1Password: an
   encrypted USB volume, or printed and stored physically. Include the `# public key:`
   comment line so the pairing is recoverable from the copy alone.
2. Label it with the date and the public key.
3. Verify the copy before trusting it: the public key it derives must be the one you
   are rotating to (`age_key_public` once the rotation is merged). A `sops decrypt`
   test is not enough, since sops also uses any other key on the machine.

   ```bash
   age-keygen -y /Volumes/<media>/home-infra-private-<YYYYMMDD>.agekey
   ```

4. Keep retired keys on the same medium. Git history needs them.

This stays manual and stays Scott's. It needs the private key and physical media, and
a script that automated it would be a script that writes the age key to disk.

## Docs to update

| File | Change |
|---|---|
| `README.md` | Secrets section: rewrite "Encrypting" around `new`/`edit`, delete "Backing plaintext up to 1Password" and replace it with "The age key is the only thing in 1Password", rewrite "Generated secrets" without `.public-key-encrypted`, add a pointer to the rotation procedure |
| `AGENTS.md` | New short Secrets rule, so an agent reaches for `show`/`edit` and not for a plaintext file that no longer exists |
| `apps/production/job-accelerator/README.md` | Replace `pull job-accelerator` and the two hand-written `SOPS_AGE_KEY_FILE=... sops decrypt` blocks (lines 26 to 69) with `show`/`edit` |
| `apps/production/olya/README.md` | Alertmanager hook token section: renamed file paths, drop the `.public-key-encrypted` explanation (lines 137 to 153) |
| `apps/production/cvat/README.md` | "plaintext in 1Password" is no longer true (line 52); `encrypt-env-files.sh` becomes `edit` |
| `apps/production/email-relay/README.md` | `encrypt-env-files.sh` line 35 becomes `edit` |
| `apps/production/email-stalwart/README.md` | The two-files-must-match rotation at lines 242 to 247 becomes two `edit` invocations |
| `apps/production/email-stalwart/bulwark/README.md` | The `cp example` then `$EDITOR` then `encrypt-env-files.sh` sequence at lines 27 to 32 becomes `new --from env.secret.bulwark.example` |
| `apps/production/arize-phoenix/README.md` | Replace the raw `sops --encrypt --age age1nur...` commands at lines 30 to 36 with `new`; the hardcoded recipient there goes stale at the first rotation |
| `apps/production/olya/scripts/setup-google-workspace-gcp/README.md` | Lines 41 to 47: the push step disappears, the edit step becomes `edit` |
| `apps/production/zot/README.md` | "Passwords live in 1Password" (line 96) becomes the new ciphertext path |
| `apps/production/zot/scripts/create-zot-htpasswd.sh` | Stop writing `.env.secret.zot-passwords`; encrypt it, drop the `push --only zot` instructions, fix the `SOPS_AGE_KEY_FILE=` sanity check it prints |
| `scripts/create-cloudflare-credentials.sh`, `create-zot-sync-credentials.sh`, `create-olya-ssh-secret.sh` | The `SOPS_AGE_KEY_FILE=$repo_dir/home-infra-private.agekey` round-trip checks they print become `onepassword-secrets.mts show` |
| `apps/production/photoprism/{scott,oksana}/kustomization.yaml`, `apps/production/cvat/kustomization.yaml` | "this file is in 1Password" comments are wrong after migration |
| `docs/specs/handoff.md` | One line while this is in flight, removed when it lands |
| `docs/security-review-2026-05-19.md` | Line 11 describes the key as living at the repo root. Leave the review as the record of that date and note the change in this spec's summary instead |

## What Scott runs by hand

Everything needing the private key or a 1Password write. In order:

1. `migrate --verify`, and read the report. Nothing else happens until it exits 0.
2. Encrypt the two orphans that are moving into git (`scripts/.env.secret.flux-bootstrap`,
   `zot/.env.secret.zot-passwords`), which needs their plaintext out of 1Password once.
3. The Cloudflare derived-value hash check above.
4. Delete the attachments in the 1Password UI, item by item, keeping only the
   `sops-age-key` item.
5. Revoke the unreferenced `scripts/.env.secret.github` PAT on GitHub.
6. Rotation steps 1, 2, 3, 4, 7 and 8 from the table above, each time.
7. The offline copy, each time.

## Risks

**Deleting a 1Password attachment whose value is not reproducible from git destroys
it.** Mitigated by verify's exit code and by doing the deletes by hand after reading
the report. 1Password version history is the only undo, and it is not forever.

**A new age key lost between generation and its second durable copy makes every file
rotated to it unreadable.** This is why 1Password and the offline copy both come
before any re-encryption, and why `rotate-age-key` refuses to run until it has
proven it can read the new key back out of 1Password.

**A half-finished rotation is quiet.** Files rotated, `_sops_config.include.sh` not
updated, or the reverse, and the next `encrypt-env-files.sh` run writes a file only
the retired key can read. `list` exiting 1 on a recipient mismatch is the check;
run it after every rotation.

**`SOPS_AGE_KEY` is readable in `/proc/<pid>/environ` by the same user for the life
of each sops child.** Same trust boundary as a key file on the same laptop, and
strictly better than the file, which persists. `SOPS_AGE_KEY_CMD` would keep the
value out of this process entirely at the cost of a 1Password prompt per file;
worth revisiting if the laptop is ever shared.

**Editors leave traces.** `edit` and `new` hand a plaintext temp file to `$EDITOR`,
and vim writes swap and undo files next to it or in `~/.vim`. `sops edit` has always
had this property; it is not new, but it is now the only plaintext that exists.

**1Password becomes a single point of failure for the whole cluster.** That is the
point of requirement 6, and the offline copy is the answer. It only works if it is
actually verified, hence the `age-keygen -y` check in step 3.

**A `git revert` that reaches back past a rotation produces ciphertext the cluster
cannot read.** Retired keys are kept for this, but the cluster only holds the current
one. Recovery is to add the retired key back to the `sops-age` secret.

## Verification

1. `list` on a checkout with no age key present and `op` signed out: succeeds, since
   it never needs either.
2. `show` and `edit` with `op` signed out: fail with the existing `SIGNIN_HELP` text
   and touch nothing.
3. `show` on one file of each sops format (dotenv, binary via `zot-htpasswd`, json via
   `cloudflare-credentials.json`) round-trips.
4. `edit` on a scratch secret in a throwaway git repo: change one value, confirm the
   ciphertext changed, the recipient did not, `show` returns the new value, and no
   plaintext file exists anywhere afterwards.
5. `new` in the same scratch repo: confirm the `.encrypted` file is created, decrypts
   to what was typed, and the temp directory is gone.
6. `migrate --verify` against the real vault, read-only: expect `match` for most of
   the 54, `1PASSWORD ONLY` for the table above, and an exit code of 1 until the
   orphans are dealt with.
7. `rotate-age-key --dry-run` with a throwaway recipient: confirm it refuses at the
   "1Password holds the new key" gate.
8. Full rotation rehearsed in the scratch repo first, including the two-key cluster
   secret, before it is run for real.
9. After the renames: `kustomize build apps/production/monitoring/prometheus` and
   `kustomize build apps/production/olya` both succeed, and `flux --context nas get
   kustomization apps` is Ready after the merge.
10. `git status` clean after every command, on every path.

## Out of scope

- No `.sops.yaml`. See the decision above.
- No change to how Flux consumes secrets. Same `secretGenerator` entries, same
  `sops-age` secret name.
- No change to `scripts/create-olya-hook-token.sh` beyond paths and comments.
- Rotating the actual key is a separate, scheduled piece of work. This change builds
  the tool and documents the procedure.

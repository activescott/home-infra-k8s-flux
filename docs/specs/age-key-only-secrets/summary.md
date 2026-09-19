# Age-key-only secrets: implementation status

Implements [plan.md](plan.md) for [#159](https://github.com/activescott/home-infra-k8s-flux/issues/159).
This is the first of two PRs. It builds the tooling; the deletions the plan describes wait
on a real `migrate --verify` run, which needs the vault and the private key.

## What landed

`scripts/onepassword-secrets.mts` reads the age private key from 1Password with `op read`
into `SOPS_AGE_KEY` in the environment of each sops child, once per run, cached in a
module-level variable. It is never written to disk, never logged, never passed as an
argument. sops merges identities from every source, so `SOPS_AGE_KEY_FILE` and
`SOPS_AGE_KEY_CMD` are deleted from that environment and `XDG_CONFIG_HOME` points at an
empty directory, which hides sops' default `keys.txt`. `edit` runs the editor through
`env -u SOPS_AGE_KEY`.

Every `*.agekey` attachment on `home-infra kubernetes secrets sops-age-key` is read and
newline-joined, except retired ones (`-retired-` in the name). sops parses `SOPS_AGE_KEY`
as key-file contents, so all the identities in it get tried. That is what makes the two-key
window during a rotation work, and it matches
what the cluster's `sops-age` secret holds at the same moment. `$OP_AGE_KEY_REF` overrides
the lookup with a single `op://` reference, for testing against a scratch item.

Commands: `show`, `edit`, `new`, `rotate-age-key`, `migrate --verify`, and a rewritten
`list` that reads git only. `push` and `pull` stay for now; until the attachments are
deleted, `pull` is the restore path if verify finds a mismatch, and removing it early
removes the only way back.

`scripts/_sops_config.include.sh` no longer sets `SOPS_AGE_KEY_FILE` or refuses to run
without a key file, so every `create-*.sh` that sources it works on a machine with no
private key. Encrypting only ever needed the public recipient.

`scripts/create-sops-age-decryption-secret.sh` builds the cluster secret from 1Password
instead of a key file at the repo root, with one data entry per `*.agekey` attachment.

## What `list` checks

Four red conditions, any of which exits 1:

- a ciphertext file is not encrypted to exactly one recipient, the one in
  `scripts/_sops_config.include.sh` (a rotation that did not finish, or an extra
  recipient that can still read it)
- a plaintext sibling is sitting next to a ciphertext file
- a plaintext file has no ciphertext at all (an orphan)
- an age private key file is on disk (see step 7 below)

Run it after every rotation. A half-finished rotation is otherwise quiet: files rotated
but the recipient of record not updated, or the reverse, and the next `encrypt-env-files.sh`
run writes a file only the retired key can read.

## Steps left for Scott

Each needs the private key, a 1Password write, or the cluster, so none of them is an
agent's to run. In order.

1. **Verify.** Nothing else happens until this exits 0 and you have read the report.

   ```bash
   ./scripts/onepassword-secrets.mts migrate --verify
   cat .validation-outputs/migrate-verify-$(date +%F).md
   ```

   Expect `match` or `match (blank lines only)` for most of the 54 files, `age key (stays)`
   for the key itself, and `1PASSWORD ONLY` for the orphans in plan.md's table. Exit code
   will be 1 until the orphans are dealt with. Anything in the report that is not in that
   table is a decision for you before anything is deleted.

2. **Move the two orphans into git.** Each needs its plaintext out of 1Password once.

   ```bash
   d=$(mktemp -d) && chmod 700 "$d"
   op read --out-file "$d/seed" \
     "op://Private/home-infra kubernetes secrets scripts/.env.secret.github.flux-bootstrap"
   ./scripts/onepassword-secrets.mts new scripts/.env.secret.flux-bootstrap --from "$d/seed"
   rm -rf "$d"
   ```

   Then the same for `zot/.env.secret.zot-passwords` into
   `apps/production/zot/.env.secret.zot-passwords`. Commit both `.encrypted` files.
   `scripts/flux-bootstrap.sh` and
   `scripts/update-flux-image-scanning-webhooks/manage-webhooks.ts` read the first one as
   the `GITHUB_TOKEN` fallback; point them at `show` in the same change.

3. **Cloudflare derived-value check.** `migrate --verify` cannot do this one: the dotenv and
   JSON forms are different bytes. Hashes only, no value reaches the terminal.

   ```bash
   ./scripts/onepassword-secrets.mts show \
     infrastructure/prod/controllers/crossplane-config/cloudflare-credentials.json \
     | jq -r .api_token | shasum -a 256
   op read "op://Private/home-infra kubernetes secrets crossplane-config/.env.secret.cloudflare" \
     | sed -n 's/^CLOUDFLARE_API_TOKEN=//p' | shasum -a 256
   # the two hashes must match
   ```

   Repeat for `cloudflare-email-credentials.json` and `.env.secret.cloudflare-email`.

4. **Re-run verify until it exits 0**, then delete the attachments by hand in the 1Password
   UI, item by item, keeping only the `sops-age-key` item. There is no delete path in any
   script, deliberately: writing one is how a verification tool becomes a data-loss tool,
   and 1Password's version history is the only undo.

5. **Revoke the unreferenced PAT** behind `scripts/.env.secret.github` on GitHub. It has
   zero references anywhere in this repo. Revoking matters more than deleting.

6. **Make the offline copy of the age key** if there is not one already, and verify it
   derives `age_key_public`. See the README's "The age key is the only thing in 1Password".

7. **Delete the local key file.** Until now `home-infra-private.agekey` at the repo root has
   been the working copy, and `list` flags it. Confirm the 1Password copy derives the
   recipient of record, and only then delete it:

   ```bash
   [ "$(op read "op://Private/home-infra kubernetes secrets sops-age-key/home-infra-private.agekey" \
        | age-keygen -y)" = \
     "$(sed -n 's/^age_key_public="\(.*\)"/\1/p' scripts/_sops_config.include.sh)" ] \
     && echo "1Password copy matches" && rm home-infra-private.agekey
   ```

   `show` never reads this file, only the key from 1Password, so it cannot tell you whether
   the file and the 1Password copy are the same key. The check above can.

8. Tell the agent, and it opens PR 2.

## Left for PR 2

After step 4, none of this has anything left to point at:

- remove `push`, `pull`, `migrate`, and the code that exists only for them
- drop the `.public-key-encrypted` suffix: two `git mv`s plus both `secretGenerator`
  references in one commit, per plan.md
- the "this file is in 1Password" comments in
  `apps/production/photoprism/{scott,oksana}/kustomization.yaml` and
  `apps/production/cvat/kustomization.yaml`
- `apps/production/zot/scripts/create-zot-htpasswd.sh` stops writing
  `.env.secret.zot-passwords` and encrypts in place
- `scripts/create-image-pull-secret-ghcr.sh` writes its temp file into a `mktemp -d`, and
  its stale output path (`apps/production/shared/ghcr-pull-secret/`, which does not exist)
  is fixed
- `scripts/create-cloudflare-credentials.sh` reads the token from `$EDITOR` in a temp dir
  instead of a `.env.secret.*` file
- `apps/production/olya/README.md`'s `.public-key-encrypted` explanation and
  `scripts/create-olya-hook-token.sh`'s paths and comments

## Note on docs/security-review-2026-05-19.md

Line 11 of that review describes the age private key as living in
`home-infra-private.agekey` at the repo root. That was true on 2026-05-19. It is not true
now: the key is in 1Password only and the checkout needs no key file. The review is left as
the record of its date.

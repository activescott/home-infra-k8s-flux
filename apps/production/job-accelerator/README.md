# job-accelerator

## Secrets

`.env.secret.app` (Secret `app-creds`):

- `NODE_ENV`: runtime mode, `production`.
- `DATABASE_URL`: full Postgres connection string, including the password.
- `JWT_SECRET`: signs session tokens.
- `ALLOWED_EMAILS`: the only addresses that can sign in.
- `FROM_EMAIL`: the `From:` address on outgoing mail, `noreply@pingpoet.com`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`: point at the email-relay Service.
- `SMTP_USER`, `SMTP_PASS`: SASL login for the relay.

`.env.secret.db` (Secret `db-creds`):

- `POSTGRES_DB`, `POSTGRES_USER`: database and role the app connects as.
- `POSTGRES_PASSWORD`: must match the password embedded in `DATABASE_URL` above.

`.env.secret.master-key.public-key-encrypted.encrypted` (Secret `master-key`):

- `MASTER_KEY_1`: the key that wraps every client's data key in the keystore. Read
  [Master key](#master-key) before touching it.

`SMTP_PASS` must also match this app's entry in email-relay's `SMTPD_SASL_USERS`
(`apps/production/email-relay/.env.secret.relay`).

### Plain env

Values that are not secret are set as plain `value:` in the manifests rather than here:

| Variable | Value | Where |
| --- | --- | --- |
| `APP_URL` | `https://job-accelerator.pingpoet.com` | `patch-app-deployment.yaml` |
| `CLIENT_DATA_OWNER_EMAIL` | `oksana@willeke.com` | `patch-app-deployment.yaml` |
| `KEYSTORE_DIR` | `/keys` | `apps/base/job-accelerator/app-deployment.yaml` |
| `MASTER_KEY_ACTIVE` | `1` | same |
| `RETENTION_PROMPT_DAYS` | `90` | same |
| `RETENTION_DELETE_DAYS` | `14` | same |

`ALLOWED_EMAILS` is the exception: it stays in the encrypted secret because this repo is
public. `CLIENT_DATA_OWNER_EMAIL` is in the clear because the app's own source names Oksana
as the account holder, so hiding the address here buys nothing.

`OPENROUTER_API_KEY` and `OPENROUTER_MODEL_*` are **not set**. There is no OpenRouter account
yet. Nothing in the app reads them until the matching and generation features land; add them
to `.env.secret.app` when the account exists.

The two `RETENTION_*` values are Scott's answers to open question 1 in the app's
`docs/design/flows.md`: prompt Oksana once a client has gone 90 days unviewed, delete 14 days
after an unanswered prompt. They are set ahead of the `retention_sweep` task that reads them.

`app-creds` and `db-creds` are ordinary plaintext-backed secrets managed through
`./scripts/onepassword-secrets.mts`, group `job-accelerator`. `master-key` is not: the
`public-key-encrypted` in its name says it has no plaintext copy anywhere, so the script lists
it and skips it rather than reporting a missing backup. Pull the plaintext with:

```bash
./scripts/onepassword-secrets.mts pull job-accelerator
```

## One-time setup

The two `.encrypted` files here were created by encrypting straight to the public key,
with no plaintext copy ever pushed to 1Password, and `SMTP_PASS` was never set. From the
repo root:

1. Generate the relay password:

   ```bash
   openssl rand -hex 32
   ```

2. Add this app to the relay's SASL users:

   ```bash
   ./scripts/onepassword-secrets.mts pull email-relay
   ```

   Append `,jobaccelerator@relay.local:<password>` to `SMTPD_SASL_USERS` in
   `apps/production/email-relay/.env.secret.relay`, then:

   ```bash
   ./scripts/encrypt-env-files.sh apps/production/email-relay
   ```

3. Decrypt both job-accelerator files to plaintext once:

   ```bash
   SOPS_AGE_KEY_FILE=home-infra-private.agekey sops decrypt \
     --input-type dotenv --output-type dotenv \
     apps/production/job-accelerator/.env.secret.app.encrypted \
     > apps/production/job-accelerator/.env.secret.app
   SOPS_AGE_KEY_FILE=home-infra-private.agekey sops decrypt \
     --input-type dotenv --output-type dotenv \
     apps/production/job-accelerator/.env.secret.db.encrypted \
     > apps/production/job-accelerator/.env.secret.db
   ```

4. Add `SMTP_PASS=<password>` to `.env.secret.app`, then:

   ```bash
   ./scripts/encrypt-env-files.sh apps/production/job-accelerator
   ```

5. Push both groups to 1Password and commit the `.encrypted` files:

   ```bash
   ./scripts/onepassword-secrets.mts push --only email-relay --only job-accelerator
   ```

## Rotation

`MASTER_KEY_1` does not follow any of this. See [Master key](#master-key).

Every other rotation follows the same steps:

1. Pull the plaintext: `./scripts/onepassword-secrets.mts pull job-accelerator`, plus
   `./scripts/onepassword-secrets.mts pull email-relay` for the relay password.
2. Edit the value(s).
3. Re-encrypt the changed directory or directories: `./scripts/encrypt-env-files.sh <dir>`.
4. Push the plaintext back: `./scripts/onepassword-secrets.mts push --only <group>...`.
5. Commit the `.encrypted` files via a PR.

`app-creds`, `db-creds`, and `relay-creds` all come from `secretGenerator` with no
`disableNameSuffixHash`, so a changed value renames the generated Secret, which rolls the
Deployment or StatefulSet the moment Flux applies it. No manual restart needed.

### Relay password (`SMTP_PASS` / `SMTPD_SASL_USERS`)

Generate a new value with `openssl rand -hex 32` and set it in both files: `SMTP_PASS`
here and this app's entry in email-relay's `SMTPD_SASL_USERS`. They must always match.

### `JWT_SECRET`

Rotating it signs everyone out; every existing session token fails verification on the
next request.

### DB password

Change it in Postgres before or together with the secret, never after. The secret is
useless until the role's actual password matches it.

```bash
kubectl --context nas -n job-accelerator-prod exec -it db-0 -- \
  psql -U jobaccelerator -c "ALTER USER jobaccelerator WITH PASSWORD '<new password>';"
```

Then update `POSTGRES_PASSWORD` and the password embedded in `DATABASE_URL` to match.

## Master key

`MASTER_KEY_1` wraps every client's data key. Those wrapped keys live in the keystore
(`/keys`, backed by the volume below), never in the database, which is what makes deleting one
client's key file shred that client everywhere. The app unwraps a check value at startup and
refuses to serve if the key does not match the keystore.

**It cannot simply be rotated.** Replacing the value does not re-key anything: every key file
in the keystore is still sealed under the old key, the check value fails to unwrap, and the
app stops. A real rotation adds `MASTER_KEY_2` beside `MASTER_KEY_1`, flips
`MASTER_KEY_ACTIVE` to `2`, runs the app's `rewrap_keys` task so every key file is unwrapped
under its recorded `kek_id` and resealed under the new one, and only then drops
`MASTER_KEY_1`. That task does not exist yet. Until it does, there is no rotation path at all.

**Losing it loses every client's data.** There is no plaintext copy and nothing in 1Password.
The ciphertext in this repo is the only copy, decryptable only by the age private key. Lose
both and every encrypted column for every client is gone; the clear columns survive, the
resumes, contact details and generated documents do not.

To generate it (first time, or on an empty keystore), from the repo root:

```bash
./scripts/create-job-accelerator-master-key.sh
git add apps/production/job-accelerator/.env.secret.master-key.public-key-encrypted.encrypted
git commit -m "Add job-accelerator master key"
git push -u origin HEAD
```

Needs `sops`, `age` and `openssl` (`brew install sops age`), but not the private key: it
encrypts to the recipient already recorded in the encrypted files in this directory, so nobody
ever sees the value. The script refuses to overwrite an existing file. `--force` overrides
that and destroys every client's data if the keystore is not empty.

## Keystore dataset

The keystore is a hostPath PV at `/mnt/thedatapool/job-accelerator-keys`
(`keys-pv.yaml`), mounted at `/keys`. The app container runs as **uid 0, gid 0** — the image
sets no `USER` and the Deployment sets no `runAsUser` — so the directory is owned by
`root:root`, mode `0700`.

It is deliberately not under `/mnt/thedatapool/app-data/` like the database volume. app-data
is replicated to `backupspool/replication` and is on the weekly B2 include list, neither
bounded at 7 days. A wrapped client key that outlives a deletion by longer than that breaks
the deletion bound (Scott, 2026-09-18, activescott/activeassistant#132; app
`docs/design/encryption.md`).

The PV uses hostPath `type: Directory`, not `DirectoryOrCreate`. **Until the dataset exists,
the pod will not start**, and that is the point: `DirectoryOrCreate` would silently mkdir the
path on the parent dataset, which is replicated and backed up, and the app would look healthy
while writing keys exactly where they must not go.

### Steps for Scott

Run these on the NAS before merging this repo's change or the app change that uses it. Nothing
here is automated, and no agent touches the NAS. Access details are in `home-infra-private`.

1. **Create the dataset.** On the Datasets page, add a dataset named `job-accelerator-keys`
   under `thedatapool`, all settings default. Equivalently, over SSH as root:

   ```bash
   zfs create thedatapool/job-accelerator-keys
   ```

   Verify:

   ```bash
   zfs list -o name,mountpoint thedatapool/job-accelerator-keys
   # NAME                              MOUNTPOINT
   # thedatapool/job-accelerator-keys  /mnt/thedatapool/job-accelerator-keys
   ```

   Do not add an SMB share for it.

2. **Own it and lock it down**, over SSH as root:

   ```bash
   chown 0:0 /mnt/thedatapool/job-accelerator-keys
   chmod 0700 /mnt/thedatapool/job-accelerator-keys
   ```

   Verify:

   ```bash
   stat -c '%u:%g %a' /mnt/thedatapool/job-accelerator-keys
   # 0:0 700
   ```

   Root can write regardless of the mode; `0700` is what keeps every other account on the box
   out of the key files.

3. **Keep it out of replication.** Under Data Protection → Replication Tasks, confirm no task
   lists `thedatapool/job-accelerator-keys` as a source and no task sources `thedatapool`
   recursively. The existing task names six datasets explicitly, so a new one is out by
   default and there is nothing to change — confirm, do not edit.

   Verify:

   ```bash
   midclt call replication.query | grep -q job-accelerator-keys \
     && echo "PRESENT - remove it" || echo "absent, correct"
   ```

4. **Keep it out of the B2 backup.** Under Data Protection → Cloud Sync Tasks, open
   "Backblaze Backup Sync" and confirm the include list still reads `app-data`, `audio`,
   `homes`, `shared-files`, `photos` and does not mention `job-accelerator-keys`. Same as
   above: an allowlist excludes a new dataset by default.

   Verify:

   ```bash
   midclt call cloudsync.query | grep -q job-accelerator-keys \
     && echo "PRESENT - remove it" || echo "absent, correct"
   ```

5. **Give it its own snapshot task.** Under Data Protection → Periodic Snapshot Tasks, add
   one:

   | Field | Value |
   | --- | --- |
   | Dataset | `thedatapool/job-accelerator-keys` |
   | Recursive | off |
   | Snapshot Lifetime | 6 days |
   | Schedule | daily |
   | Naming Schema | leave the default |
   | Enabled | on |

   Create it in the UI, not with `zfs snapshot`: only a middleware-owned task recurs and
   prunes.

   Verify the task, then the snapshots after a day:

   ```bash
   midclt call pool.snapshottask.query | python3 -c '
   import json, sys
   for t in json.load(sys.stdin):
       print(t["dataset"], "recursive=%s" % t["recursive"],
             "keep=%s %s" % (t["lifetime_value"], t["lifetime_unit"]), t["naming_schema"])'
   # thedatapool/job-accelerator-keys recursive=False keep=6 DAY auto-%Y-%m-%d_%H-%M

   zfs list -t snapshot -s creation -o name,creation -r thedatapool/job-accelerator-keys
   ```

6. **Check no parent task covers it for longer.** In that same list, any task whose Dataset is
   `thedatapool` with Recursive on also snapshots this dataset, on its own lifetime, which
   would put wrapped keys past the 7-day bound. The `recursive=` column printed above is the
   check. If one exists, add `thedatapool/job-accelerator-keys` to its Exclude list.

   A week after step 5, confirm the bound actually holds — the oldest snapshot should never be
   more than 7 days old:

   ```bash
   zfs list -H -t snapshot -s creation -o name,creation -r thedatapool/job-accelerator-keys \
     | head -1
   ```

## Sending mail

`pingpoet.com` must be onboarded to Cloudflare Email Sending before the relay can send as
`noreply@pingpoet.com`.

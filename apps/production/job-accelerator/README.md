# job-accelerator

## Secrets

`.env.secret.app` (Secret `app-creds`):

- `NODE_ENV`: runtime mode, `production`.
- `DATABASE_URL`: full Postgres connection string, including the password.
- `JWT_SECRET`: signs session tokens.
- `ALLOWED_EMAILS`: the only addresses that can sign in.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`: point at the email-relay Service.
- `SMTP_USER`, `SMTP_PASS`: SASL login for the relay.

`.env.secret.db` (Secret `db-creds`):

- `POSTGRES_DB`, `POSTGRES_USER`: database and role the app connects as.
- `POSTGRES_PASSWORD`: must match the password embedded in `DATABASE_URL` above.

`.env.secret.master-key.public-key-encrypted.encrypted` (Secret `master-key`):

- `MASTER_KEY_1`: the key that wraps every client's data key in the keystore. Read
  [Master key](#master-key) before touching it.

`.env.secret.client-owner.public-key-encrypted.encrypted` (Secret `client-owner`):

- `CLIENT_DATA_OWNER_EMAIL`: the one address that may read client records. Not a
  credential, but a private person's address, so it is encrypted for the same reason
  `ALLOWED_EMAILS` is. To change it, see
  [`CLIENT_DATA_OWNER_EMAIL`](#client_data_owner_email).

`SMTP_PASS` must also match this app's entry in email-relay's `SMTPD_SASL_USERS`
(`apps/production/email-relay/.env.secret.relay`).

### Plain env

Values that are not secret are set as plain `value:` in the manifests rather than here:

| Variable | Value | Where |
| --- | --- | --- |
| `APP_URL` | `https://job-accelerator.pingpoet.com` | `patch-app-deployment.yaml` |
| `FROM_EMAIL` | `job-accelerator-noreply@pingpoet.com` | `patch-app-from-email.yaml` |
| `KEYSTORE_DIR` | `/keys` | `apps/base/job-accelerator/app-deployment.yaml` |
| `MASTER_KEY_ACTIVE` | `1` | same |
| `RETENTION_PROMPT_DAYS` | `90` | same |
| `RETENTION_DELETE_DAYS` | `14` | same |

The model names are not in this table: `OPENROUTER_MODEL_PARSE_PROFILE` and
`OPENROUTER_MODEL_SUGGEST_EMPLOYERS` come from the generated `models` ConfigMap
(`apps/base/job-accelerator/kustomization.yaml`), read by both the app and worker
Deployments through `envFrom` so the two cannot drift.

The worker also gets `KEYSTORE_DIR`, `MASTER_KEY_ACTIVE` and `MASTER_KEY_1` (the same
values as the app, set directly in `worker-deployment.yaml`), plus the `keys` volume,
mounted read-only since the worker only reads keys.

`ALLOWED_EMAILS` and `CLIENT_DATA_OWNER_EMAIL` stay in encrypted secrets because this repo
is public and both name private people. A value being guessable is not a reason to publish
it. `FROM_EMAIL` is different: it is a role account that rides in the headers of every
message the app sends, so it is already public. The base deployment still reads it from
`app-creds` and `patch-app-from-email.yaml` overrides that with a plain value, which leaves
the key in `.env.secret.app` unused.

The models are plain env too, in the `models` ConfigMap above. `OPENROUTER_API_KEY` is not set yet; add it to
`.env.secret.app` with `./scripts/onepassword-secrets.mts edit
apps/production/job-accelerator/.env.secret.app`. The deployment marks it `optional: true`, so
the pod starts without it. The key belongs to the OpenRouter workspace "Job Accelerator", which
enforces zero data retention and disallows training on its traffic.

The two `RETENTION_*` values are Scott's answers to open question 1 in the app's
`docs/design/flows.md`: prompt Oksana once a client has gone 90 days unviewed, delete 14 days
after an unanswered prompt. They are set ahead of the `retention_sweep` task that reads them.

`app-creds` and `db-creds` are ordinary SOPS secrets; read or change either with the commands
below. `master-key` and `client-owner` are not: the `public-key-encrypted` in their names says
nobody has ever seen their values, so there is nothing to decrypt for a person to read. See
[Master key](#master-key) and [`CLIENT_DATA_OWNER_EMAIL`](#client_data_owner_email).

```bash
./scripts/onepassword-secrets.mts show apps/production/job-accelerator/.env.secret.app
./scripts/onepassword-secrets.mts edit apps/production/job-accelerator/.env.secret.app
```

## One-time setup

The two `.encrypted` files here were created by encrypting straight to the public key and
`SMTP_PASS` was never set. From the repo root:

1. Generate the relay password:

   ```bash
   openssl rand -hex 32
   ```

2. Add this app to the relay's SASL users. Append
   `,jobaccelerator@relay.local:<password>` to `SMTPD_SASL_USERS`:

   ```bash
   ./scripts/onepassword-secrets.mts edit apps/production/email-relay/.env.secret.relay
   ```

3. Add `SMTP_PASS=<password>` here:

   ```bash
   ./scripts/onepassword-secrets.mts edit apps/production/job-accelerator/.env.secret.app
   ```

4. Commit both `.encrypted` files.

## Rotation

`MASTER_KEY_1` does not follow any of this. See [Master key](#master-key).
`CLIENT_DATA_OWNER_EMAIL` is its own case; it has its own steps
[below](#client_data_owner_email).

Every other rotation is `edit` on each file that holds the value, then a PR with the
`.encrypted` files:

```bash
./scripts/onepassword-secrets.mts edit apps/production/job-accelerator/.env.secret.app
./scripts/onepassword-secrets.mts edit apps/production/email-relay/.env.secret.relay
```

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

### `CLIENT_DATA_OWNER_EMAIL`

There is no plaintext file to edit and nothing in 1Password. Re-encrypt straight to the
recipient the file already records, so the address never lands on disk in the clear:

```bash
cd apps/production/job-accelerator
file=.env.secret.client-owner.public-key-encrypted.encrypted
recipient=$(sed -n 's/^sops_age__list_[0-9]*__map_recipient=//p' "$file")
owner='first@example.com,second@example.com'
printf 'CLIENT_DATA_OWNER_EMAIL=%s\n' "$owner" | sops encrypt \
  --age "$recipient" --input-type dotenv --output-type dotenv \
  --filename-override "$file" > "$file.tmp" && mv "$file.tmp" "$file"
```

`read` keeps the value out of shell history and out of any process's argv, and the redirect
goes to a temp file so a failed encrypt leaves the previous ciphertext intact. Commit the
`.encrypted` file via a PR; the generated Secret's name hash changes, which rolls the
Deployment.

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
(`keys-pv.yaml`), mounted at `/keys`. The app container runs as **uid 1000, gid 1000**
(activescott/job-accelerator#101) — the image sets `USER 1000` and the Deployment sets
`runAsUser: 1000` — so the directory must be owned by `1000:1000`, mode `0700`.

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
   chown 1000:1000 /mnt/thedatapool/job-accelerator-keys
   chmod 0700 /mnt/thedatapool/job-accelerator-keys
   ```

   Verify:

   ```bash
   stat -c '%u:%g %a' /mnt/thedatapool/job-accelerator-keys
   # 1000:1000 700
   ```

   Root can write regardless of the mode; `0700` is what keeps every other account on the box
   out of the key files.

   Run it again once the new pod is `Running`. The old root pod can still write root-owned
   0600 key files in the gap between this chown and the rollout, and the new pod couldn't
   read them. The command is safe to repeat.

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

## Worker

The `worker` Deployment runs the app image as `node build/worker/worker.js` and polls every
watched ATS board hourly. A board is watched by running `add-feed.js` in that pod, which
records the board and polls it once. It is idempotent: re-running it for a board already
watched changes nothing but polls again.

```bash
kubectl --context nas -n job-accelerator-prod exec deploy/worker -- \
  node build/worker/scripts/add-feed.js greenhouse gitlab GitLab gitlab.com
kubectl --context nas -n job-accelerator-prod exec deploy/worker -- \
  node build/worker/scripts/add-feed.js lever spotify Spotify spotify.com
kubectl --context nas -n job-accelerator-prod exec deploy/worker -- \
  node build/worker/scripts/add-feed.js ashby ashby Ashby ashbyhq.com
```

Arguments are `<source> <board-token> <employer-name> [domain] [host]`. This is a stopgap
until the app's suggestions page (activescott/activeassistant#144) adds boards itself.

## Sending mail

`pingpoet.com` was onboarded to Cloudflare Email Sending on 2026-09-18, so the relay can
send as `job-accelerator-noreply@pingpoet.com`. email-relay's
`POSTFIX_smtpd_sender_login_maps` ties `@pingpoet.com` to the `jobaccelerator@relay.local`
SASL login, which is what `SMTP_USER`/`SMTP_PASS` authenticate as, so any local part on the
domain works without another relay change.

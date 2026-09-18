## Google Workspace OAuth Setup for Olya

Prerequisites: Node.js 18+, a browser, GCP project `pingpoet-olya-ws` with the APIs
backing every scope in `get-tokens.mjs`'s `SCOPES` list enabled (Gmail, Calendar,
Docs, Drive, Chat, Admin SDK, Slides, Sheets — see
[activescott/activeassistant#78](https://github.com/activescott/activeassistant/issues/78)
for the full scope-to-API mapping), and every one of those scopes registered on the
OAuth consent screen (Console → OAuth consent screen → Scopes) — a token request for
an unregistered scope fails at the consent screen, not at token exchange.

### 1. Create OAuth Client (one-time, in GCP Console)

1. Go to https://console.cloud.google.com/apis/credentials?project=pingpoet-olya-ws
2. Click **Create Credentials** → **OAuth client ID**.
3. Application type: **Desktop app**. Name it e.g. `olya-workspace-mcp`.
4. No redirect URI config needed for the Desktop app type — the script uses `http://localhost:PORT` dynamically.
5. Save the client ID and client secret shown after creation.

### 2. First time only: create the secrets template

```bash
cp apps/production/olya/env.secret.google-workspace.example \
   apps/production/olya/.env.secret.google-workspace
```

Edit the copy in by hand once, filling in the client ID and client secret (leave
`google_workspace_credentials_json` as the placeholder — the next step fills it in).

### 3. Run the token exchange

```bash
node apps/production/olya/scripts/setup-google-workspace-gcp/get-tokens.mjs
```

Enter the client ID and client secret when prompted. Open the printed URL, sign in as
olya@pingpoet.com, grant access. The script catches the redirect, exchanges the code,
and prints the credentials JSON — then, each gated by its own `[y/N]` prompt so nothing
happens without your say-so, offers to:

1. write that JSON into `google_workspace_credentials_json=` in
   `.env.secret.google-workspace`, and
2. re-encrypt it (`scripts/encrypt-env-files.sh`).

Delete the plaintext afterwards; the committed ciphertext is the only copy. To change the
value later, use
`./scripts/onepassword-secrets.mts edit apps/production/olya/.env.secret.google-workspace`.

Run this yourself, not via the agent — the plaintext file is exactly what the "DO
NOT TYPE A REAL VALUE" header at the top of it warns about; the script does the
reading and writing so the agent never has to.

After a `y` at step 1, still commit `apps/production/olya/.env.secret.google-workspace.encrypted`
yourself once step 2 finishes.

### 4. What happens next

Olya will configure the MCP server in openclaw.json, add the secret mounts to the statefulset, and test the newly-enabled scopes (Docs, Drive, Chat, People, Slides, Sheets).

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

### 2. First time only: create the secret

Skip this if `apps/production/browser-chaperone/.env.secret.mcp-gateway-google.encrypted` already exists;
it is the only copy, and `new` refuses to overwrite it.

```bash
./scripts/onepassword-secrets.mts new apps/production/browser-chaperone/.env.secret.mcp-gateway-google \
  --from apps/production/browser-chaperone/env.secret.mcp-gateway-google.example
```

Fill in the client ID and client secret in the editor, and leave
`google_workspace_credentials_json` as the placeholder for the next step.

### 3. Run the token exchange

```bash
node apps/production/olya/scripts/setup-google-workspace-gcp/get-tokens.mjs
```

Enter the client ID and client secret when prompted. Open the printed URL, sign in as
olya@pingpoet.com, grant access. The script catches the redirect, exchanges the code,
and prints the credentials JSON. After a `[y/N]` prompt it replaces the
`google_workspace_credentials_json=` line in
`.env.secret.mcp-gateway-google.encrypted`: it decrypts with `onepassword-secrets.mts show`,
changes that one line in memory, and re-encrypts, so no plaintext file is written and the
other values are kept. Answer `n` and it prints the `edit` command to paste the JSON by hand.

Run this yourself, not via the agent: the JSON it prints is a live refresh token.

Commit `apps/production/browser-chaperone/.env.secret.mcp-gateway-google.encrypted` yourself afterwards.

### 4. What happens next

Olya reaches the credential through the MCP gateway, so nothing is added to the olya statefulset. Test the newly-enabled scopes (Docs, Drive, Chat, People, Slides, Sheets).

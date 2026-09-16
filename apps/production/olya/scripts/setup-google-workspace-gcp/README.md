## Google Workspace OAuth Setup for Olya

Prerequisites: Node.js 18+, a browser, GCP project `pingpoet-olya-ws` with Gmail and Calendar APIs enabled.

### 1. Create OAuth Client (one-time, in GCP Console)

1. Go to https://console.cloud.google.com/apis/credentials?project=pingpoet-olya-ws
2. Click **Create Credentials** → **OAuth client ID**.
3. Application type: **Desktop app**. Name it e.g. `olya-workspace-mcp`.
4. No redirect URI config needed for the Desktop app type — the script uses `http://localhost:PORT` dynamically.
5. Save the client ID and client secret shown after creation.

### 2. Run the token exchange

```bash
node apps/production/olya/scripts/setup-google-workspace-gcp/get-tokens.mjs
```

Enter the client ID and client secret when prompted. Open the printed URL, sign in as olya@pingpoet.com, grant access. The script catches the redirect, exchanges the code, and prints the credentials JSON.

### 3. Fill in the secrets template

```bash
cp apps/production/olya/env.secret.google-workspace.example \
   apps/production/olya/.env.secret.google-workspace
```

Edit the copy with the client ID, client secret, and the full credentials JSON (on one line).

Then encrypt (run this yourself, not via the agent):

```bash
./scripts/encrypt-env-files.sh apps/production/olya/.env.secret.google-workspace
```

### 4. What happens next

Olya will configure the MCP server in openclaw.json, add the secret mounts to the statefulset, and test email/calendar access.

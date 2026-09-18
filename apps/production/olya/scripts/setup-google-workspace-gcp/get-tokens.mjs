#!/usr/bin/env node
// OAuth token exchange for Google Workspace MCP setup.
// No npm dependencies. Writing the result into the encrypted secret needs sops and op.
// Usage: node get-tokens.mjs (prompts for client ID and secret)

import http from "http";
import https from "https";
import { URL } from "url";
import readline from "readline";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

// Full set per https://github.com/activescott/activeassistant/issues/78 - the MCP
// server's default-enabled features (Docs, Drive, Calendar, Chat, Gmail, People,
// Slides, Sheets) all need their scope present in the token, not just Gmail/Calendar.
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/presentations.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const relPath = "apps/production/olya/.env.secret.google-workspace";
const plaintextPath = join(repoDir, relPath);
const encryptedPath = `${plaintextPath}.encrypted`;
const CREDENTIALS_KEY = "google_workspace_credentials_json";

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

async function confirm(question) {
  const answer = await prompt(`${question} [y/N] `);
  return answer.trim().toLowerCase() === "y";
}

// The committed ciphertext is the only copy of this secret. It is updated in memory: the
// current values come out of `onepassword-secrets.mts show`, one line is replaced, and the
// result is encrypted from stdin, so no plaintext file is ever written.
function updateEncryptedCredentials(output) {
  const shown = execFileSync(join(repoDir, "scripts/onepassword-secrets.mts"), ["show", relPath], {
    cwd: repoDir,
    stdio: ["inherit", "pipe", "inherit"],
  });
  const lines = shown.toString("utf8").split("\n");
  const idx = lines.findIndex((line) => line.trim().startsWith(`${CREDENTIALS_KEY}=`));
  if (idx === -1) {
    fail(`No "${CREDENTIALS_KEY}=" line in ${relPath}.encrypted; add it with \`edit\` first.`);
  }
  lines[idx] = `${CREDENTIALS_KEY}=${JSON.stringify(output)}`;

  const include = readFileSync(join(repoDir, "scripts/_sops_config.include.sh"), "utf8");
  const recipient = include.match(/^age_key_public="([^"]+)"/m)?.[1];
  if (!recipient) fail("no age_key_public in scripts/_sops_config.include.sh");
  // Through `cat` so sops reads /dev/stdin from a real pipe: Node's child stdin is a
  // socket on Linux, which /dev/stdin cannot open.
  const encrypted = execFileSync(
    "sh",
    [
      "-c",
      'cat | exec sops "$@"',
      "sh",
      "encrypt",
      "--age",
      recipient,
      "--input-type",
      "dotenv",
      "--output-type",
      "dotenv",
      "--filename-override",
      relPath,
      "/dev/stdin",
    ],
    { cwd: repoDir, input: lines.join("\n"), stdio: ["pipe", "pipe", "inherit"] }
  );
  // Write next to the target and rename, so a failure cannot truncate the only copy.
  const staging = `${encryptedPath}.tmp.${process.pid}`;
  writeFileSync(staging, encrypted, { mode: 0o644 });
  renameSync(staging, encryptedPath);
}

async function runFollowUpSteps(output) {
  console.log();
  const editHint =
    `Paste the JSON above as ${CREDENTIALS_KEY} with:\n` +
    `  ./scripts/onepassword-secrets.mts edit ${relPath}`;
  if (existsSync(plaintextPath)) {
    fail(
      `${plaintextPath} exists. The .encrypted file is the only copy of record, so this ` +
        `script will not encrypt a local file over it. Move it out of the repo, then:\n${editHint}`
    );
  }
  if (!existsSync(encryptedPath)) {
    fail(
      `${relPath}.encrypted does not exist. Create it first:\n` +
        `  ./scripts/onepassword-secrets.mts new ${relPath} \\\n` +
        `    --from apps/production/olya/env.secret.google-workspace.example`
    );
  }

  if (await confirm(`Write the new credentials into ${relPath}.encrypted?`)) {
    try {
      updateEncryptedCredentials(output);
    } catch (e) {
      fail(`${e.message.split("\n")[0]}\n${relPath}.encrypted is unchanged. ${editHint}`);
    }
    console.log(`Updated ${relPath}.encrypted`);
  } else {
    console.log(`Skipped. ${editHint}`);
    return;
  }

  console.log(
    "\nDone. Also still pending per issue #78: rotate the GCP OAuth client secret " +
      "that was exposed in chat during initial setup, and commit the updated " +
      ".encrypted file."
  );
}

function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString();
    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Token exchange failed (HTTP ${res.statusCode}): ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from token endpoint: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const clientId = await prompt("Client ID: ");
if (!clientId) fail("Client ID is required");
const clientSecret = await prompt("Client secret: ");
if (!clientSecret) fail("Client secret is required");

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, "http://localhost");
  const code = reqUrl.searchParams.get("code");
  const error = reqUrl.searchParams.get("error");
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Authorization failed</h1><p>You can close this window.</p>");
    server.close();
    fail(`Authorization failed: ${error}`);
    return;
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>No auth code received</h1><p>You can close this window.</p>");
    return;
  }

  try {
    const tokens = await exchangeCode({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });
    const output = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
    };
    console.log(JSON.stringify(output));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Success!</h1><p>Credentials printed in the terminal. You can close this window.</p>");
    server.close();
    await runFollowUpSteps(output);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end("<h1>Token exchange failed</h1><p>See the terminal for details.</p>");
    server.close();
    fail(e.message);
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  console.log("Open this URL in your browser:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for redirect...");
});

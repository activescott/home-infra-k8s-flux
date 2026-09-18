#!/usr/bin/env node
// OAuth token exchange for Google Workspace MCP setup.
// No dependencies — Node.js builtins only.
// Usage: node get-tokens.mjs (prompts for client ID and secret)

import http from "http";
import https from "https";
import { URL } from "url";
import readline from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
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

// This script - not the agent - is the only thing allowed to touch this path. See
// the "DO NOT TYPE A REAL VALUE" header in the plaintext file itself for why.
const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const plaintextPath = join(repoDir, "apps/production/olya/.env.secret.google-workspace");
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

function writeCredentialsLine(output) {
  if (!existsSync(plaintextPath)) {
    fail(
      `${plaintextPath} does not exist yet. Copy the template first:\n` +
        `  cp apps/production/olya/env.secret.google-workspace.example ${plaintextPath}`
    );
  }
  const lines = readFileSync(plaintextPath, "utf8").split("\n");
  const idx = lines.findIndex((line) => line.trim().startsWith(`${CREDENTIALS_KEY}=`));
  if (idx === -1) {
    fail(`No "${CREDENTIALS_KEY}=" line found in ${plaintextPath} - template drift, fix by hand.`);
  }
  lines[idx] = `${CREDENTIALS_KEY}=${JSON.stringify(output)}`;
  writeFileSync(plaintextPath, lines.join("\n"), { mode: 0o600 });
}

function encryptPlaintextFile() {
  execFileSync(join(repoDir, "scripts/encrypt-env-files.sh"), [plaintextPath], {
    cwd: repoDir,
    stdio: "inherit",
  });
}

function pushToOnePassword() {
  execFileSync(join(repoDir, "scripts/onepassword-secrets.mts"), ["push", "--only", "olya"], {
    cwd: repoDir,
    stdio: "inherit",
  });
}

async function runFollowUpSteps(output) {
  console.log();
  if (await confirm(`Write the new credentials into ${plaintextPath}?`)) {
    writeCredentialsLine(output);
    console.log(`Wrote ${plaintextPath}`);
  } else {
    console.log("Skipped - update the file yourself before encrypting/pushing.");
    return;
  }

  if (await confirm("Re-encrypt it now (scripts/encrypt-env-files.sh)?")) {
    encryptPlaintextFile();
  } else {
    console.log("Skipped - remember to encrypt before committing.");
    return;
  }

  if (await confirm("Push the updated plaintext to 1Password now (--only olya)?")) {
    pushToOnePassword();
  } else {
    console.log("Skipped - remember to back it up to 1Password.");
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

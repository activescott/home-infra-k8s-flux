#!/usr/bin/env node
// OAuth token exchange for Google Workspace MCP setup.
// No dependencies — Node.js builtins only.
// Usage: node get-tokens.mjs --client-id ID --client-secret SECRET

import http from "http";
import https from "https";
import { URL } from "url";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client-id") out.clientId = argv[++i];
    else if (argv[i] === "--client-secret") out.clientSecret = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
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

const { clientId, clientSecret } = parseArgs(process.argv.slice(2));
if (!clientId) fail("--client-id is required");
if (!clientSecret) fail("--client-secret is required");

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

#!/usr/bin/env node
/**
 * One time helper: turns your Google OAuth client into a long lived refresh
 * token. Run it locally, nothing leaves your machine except the calls to
 * Google itself.
 *
 *   node scripts/get-refresh-token.mjs
 *
 * Before running, add this exact redirect URI to your OAuth client in the
 * Google Cloud console:
 *
 *   http://localhost:8787/callback
 */
import http from "node:http";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";

const PORT = 8787;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/tasks";

const rl = readline.createInterface({ input: stdin, output: stdout });
const clientId = (process.env.GOOGLE_CLIENT_ID ?? (await rl.question("Client ID: "))).trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? (await rl.question("Client secret: "))).trim();
rl.close();

if (!clientId || !clientSecret) {
  console.error("Both the client ID and client secret are required.");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

function openBrowser(url) {
  const command =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("Not found");
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    res.writeHead(400, { "content-type": "text/html" })
       .end(`<h1>Authorization failed</h1><p>${error ?? "no code returned"}</p>`);
    console.error(`\nAuthorization failed: ${error ?? "no code returned"}`);
    server.close();
    process.exit(1);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const payload = await response.json();

  if (!payload.refresh_token) {
    res.writeHead(400, { "content-type": "text/html" })
       .end("<h1>No refresh token</h1><p>Check the terminal.</p>");
    console.error("\nGoogle did not return a refresh token.");
    console.error(JSON.stringify(payload, null, 2));
    console.error(
      "\nIf you have authorized this client before, revoke it at " +
      "https://myaccount.google.com/permissions and run this again.",
    );
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "content-type": "text/html" }).end(
    "<h1>Done</h1><p>Your refresh token is in the terminal. You can close this tab.</p>",
  );

  console.log("\nRefresh token:\n");
  console.log(payload.refresh_token);
  console.log("\nNow store it, along with the client id and secret:\n");
  console.log("  npx wrangler secret put GOOGLE_CLIENT_ID");
  console.log("  npx wrangler secret put GOOGLE_CLIENT_SECRET");
  console.log("  npx wrangler secret put GOOGLE_REFRESH_TOKEN");
  console.log("\nDo not commit it. Treat it like a password.\n");
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`\nListening on ${REDIRECT}`);
  console.log("Opening your browser. If nothing happens, paste this in:\n");
  console.log(authUrl.toString() + "\n");
  console.log('Google will warn that the app is not verified. Choose "Advanced",');
  console.log('then "Go to <your app> (unsafe)". It is your own app.\n');
  openBrowser(authUrl.toString());
});

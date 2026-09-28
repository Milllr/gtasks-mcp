#!/usr/bin/env node
/**
 * Prints a Google refresh token and stops there. Use this when you only want
 * the token, for example to rotate it later. For first time setup run
 * `npm run setup` instead, which also stores the secrets and tests the deploy.
 *
 *   node scripts/get-refresh-token.mjs
 *
 * Your OAuth client needs http://localhost:8787/callback as an authorized
 * redirect URI.
 */
import { ask, getRefreshToken } from "./lib/oauth-flow.mjs";

const clientId = (process.env.GOOGLE_CLIENT_ID ?? (await ask("Client ID: "))).trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? (await ask("Client secret: ", { mask: true }))).trim();

if (!clientId || !clientSecret) {
  console.error("Both the client ID and client secret are required.");
  process.exit(1);
}

try {
  const refreshToken = await getRefreshToken(clientId, clientSecret);
  console.log("\nRefresh token:\n");
  console.log(refreshToken);
  console.log("\nStore it, along with the client id and secret:\n");
  console.log("  npx wrangler secret put GOOGLE_CLIENT_ID");
  console.log("  npx wrangler secret put GOOGLE_CLIENT_SECRET");
  console.log("  npx wrangler secret put GOOGLE_REFRESH_TOKEN");
  console.log("\nDo not commit it. Treat it like a password.\n");
  process.exit(0);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

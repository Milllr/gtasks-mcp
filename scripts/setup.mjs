#!/usr/bin/env node
/**
 * Everything after the Google Cloud console work, in one command:
 *
 *   npm run setup
 *
 * Asks for your OAuth client, runs the Google authorization dance, asks for
 * the password you want to protect the connector with, pushes all four
 * secrets to Cloudflare, then smoke tests the deployed Worker.
 *
 * Secret values are piped straight into wrangler. They are never written to
 * disk and never printed back.
 */
import { spawn } from "node:child_process";
import { ask, getRefreshToken } from "./lib/oauth-flow.mjs";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(npx, ["wrangler", "secret", "put", name], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler could not set ${name}.\n${stderr.trim()}`));
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

/**
 * `shell` defaults on for Windows because npx resolves through a .cmd shim.
 * Pass false for anything given as an absolute path: node lives under
 * C:\Program Files, and a shell would split that at the space.
 */
function run(command, args, useShell = process.platform === "win32") {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: useShell });
    child.on("close", resolve);
  });
}

/**
 * Same as run, but keeps a copy of the output. `wrangler deployments list`
 * does not print the workers.dev URL, so the deploy output is where we learn
 * it, which also means the URL we test is the one we just shipped to.
 */
function runCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let out = "";
    const tee = (stream, sink) => stream.on("data", (chunk) => {
      out += chunk.toString();
      sink.write(chunk);
    });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", () => resolve({ code: 1, out }));
  });
}

async function main() {
  console.log("\ngtasks-mcp setup\n");
  console.log("Before this works you need an OAuth client from the Google Cloud console,");
  console.log("with http://localhost:8787/callback as an authorized redirect URI, and the");
  console.log("consent screen PUBLISHED rather than left in Testing. See the README.\n");

  const clientId = (process.env.GOOGLE_CLIENT_ID ?? (await ask("Google client ID: "))).trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? (await ask("Google client secret: ", { mask: true }))).trim();
  if (!clientId || !clientSecret) throw new Error("Both the client ID and secret are required.");

  console.log("\nStarting the Google authorization flow.");
  const refreshToken = await getRefreshToken(clientId, clientSecret);
  console.log("Got a refresh token.\n");

  let password = "";
  while (password.length < 8) {
    password = await ask("Choose a connector password (8 characters or more): ", { mask: true });
    if (password.length < 8) console.log("  Too short.");
  }
  const again = await ask("Type it once more: ", { mask: true });
  if (password !== again) throw new Error("The two passwords did not match. Run setup again.");

  console.log("\nPushing secrets to Cloudflare.");
  for (const [name, value] of [
    ["GOOGLE_CLIENT_ID", clientId],
    ["GOOGLE_CLIENT_SECRET", clientSecret],
    ["GOOGLE_REFRESH_TOKEN", refreshToken],
    ["MCP_PASSWORD", password],
  ]) {
    await putSecret(name, value);
    console.log(`  set ${name}`);
  }

  console.log("\nRedeploying so the Worker picks them up.");
  const deploy = await runCapture(npx, ["wrangler", "deploy"]);
  if (deploy.code !== 0) throw new Error("The deploy failed. Scroll up for wrangler's output.");

  const match = deploy.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  const url = match ? match[0] : null;
  if (!url) {
    console.log("\nCould not work out the Worker URL. Run the smoke test by hand:");
    console.log("  node scripts/smoke-test.mjs <your worker url> <your password>");
    return;
  }

  console.log(`\nSmoke testing ${url}`);
  const failed = await run(process.execPath, ["scripts/smoke-test.mjs", url, password], false);

  if (failed) {
    console.log("\nSomething is off. `npx wrangler tail` will show you live logs.");
    process.exit(1);
  }

  console.log("\nDone. Add this as a custom connector in Claude:\n");
  console.log(`  ${url}/mcp\n`);
  console.log("Claude will ask for the password you just chose.\n");
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});

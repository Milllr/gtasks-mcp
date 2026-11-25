#!/usr/bin/env node
/**
 * Walks the whole connector handshake the way Claude does: discovery,
 * dynamic registration, PKCE authorize, token exchange, then an authorized
 * tools/list. Run it against a dev server or against production.
 *
 *   node scripts/smoke-test.mjs http://127.0.0.1:8788 your-password
 *
 * Tool calls are NOT exercised, so this never touches your real tasks.
 */
const base = (process.argv[2] ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const password = process.argv[3] ?? "test-password";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  console.log(`\ngtasks-mcp smoke test against ${base}\n`);

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  check("protected resource metadata", prm.authorization_servers?.[0] === base);

  const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check("authorization server metadata", asm.registration_endpoint === `${base}/register`);
  check("advertises PKCE S256", asm.code_challenge_methods_supported?.includes("S256"));

  const unauth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check(
    "unauthenticated /mcp challenges",
    unauth.status === 401 && (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
    `status ${unauth.status}`,
  );

  const reg = await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "smoke-test" }),
    })
  ).json();
  check("dynamic client registration", typeof reg.client_id === "string" && reg.client_id.length > 20);

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  const authQuery = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "smoke",
  });

  const page = await fetch(`${base}/authorize?${authQuery}`);
  check("consent page renders", page.status === 200 && (await page.text()).includes('name="password"'));

  const wrong = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(authQuery), password: "definitely-wrong" }),
    redirect: "manual",
  });
  check("wrong password rejected", wrong.status === 401, `status ${wrong.status}`);

  const allowed = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(authQuery), password }),
    redirect: "manual",
  });
  const location = new URL(allowed.headers.get("location") ?? "http://x/");
  const code = location.searchParams.get("code");
  check("correct password issues a code", !!code, `status ${allowed.status}`);
  check("state is echoed back", location.searchParams.get("state") === "smoke");

  const badPkce = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: "wrong-verifier",
    }),
  });
  check("PKCE mismatch rejected", badPkce.status === 400, `status ${badPkce.status}`);

  const tokens = await (
    await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        client_id: reg.client_id,
        code_verifier: verifier,
      }),
    })
  ).json();
  check("token exchange", typeof tokens.access_token === "string");

  const auth = { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" };

  const init = await (
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
      }),
    })
  ).json();
  check("initialize", init.result?.serverInfo?.name === "gtasks-mcp", init.result?.protocolVersion ?? "");

  const list = await (
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    })
  ).json();
  const tools = list.result?.tools ?? [];
  check("tools/list", tools.length === 13, `${tools.length} tools`);

  const refreshed = await (
    await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    })
  ).json();
  check("refresh token grant", typeof refreshed.access_token === "string");

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nSmoke test crashed:", error.message);
  process.exit(1);
});

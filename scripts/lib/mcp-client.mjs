/**
 * Talks to the deployed Worker the way Claude does: discovery, dynamic
 * registration, PKCE authorize with the password, token exchange, then
 * ordinary tools/call requests. Used by the migration script so bulk work
 * runs as a loop rather than as hundreds of conversational tool calls.
 */
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function connect(baseUrl, password) {
  const base = baseUrl.replace(/\/$/, "");

  const reg = await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "gtasks-migrate" }),
    })
  ).json();
  if (!reg.client_id) throw new Error("Client registration failed. Is the Worker configured?");

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  const query = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "migrate",
  });

  const authorized = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(query), password }),
    redirect: "manual",
  });
  if (authorized.status === 401) throw new Error("That password was not accepted by the Worker.");

  const code = new URL(authorized.headers.get("location") ?? "http://x/").searchParams.get("code");
  if (!code) throw new Error(`Authorize did not return a code (status ${authorized.status}).`);

  const tokens = await (
    await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: reg.client_id,
        code_verifier: verifier,
      }),
    })
  ).json();
  if (!tokens.access_token) throw new Error("Token exchange failed.");

  let id = 0;
  async function rpc(method, params) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const payload = await response.json();
    if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
    return payload.result;
  }

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "gtasks-migrate", version: "1.0.0" },
  });

  /** Calls a tool and returns its text output, throwing on a tool level error. */
  async function call(name, args) {
    const result = await rpc("tools/call", { name, arguments: args });
    const body = (result.content ?? []).map((part) => part.text ?? "").join("\n");
    if (result.isError) throw new Error(`${name}: ${body}`);
    return body;
  }

  const tools = (await rpc("tools/list")).tools ?? [];

  return { call, tools: tools.map((t) => t.name) };
}

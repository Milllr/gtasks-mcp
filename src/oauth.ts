/**
 * A deliberately small OAuth 2.1 authorization server, just big enough for
 * Claude's connector flow. One user, one password, no database.
 */
import type { Env } from "./types.ts";
import { sign, verify, safeEqual, s256, randomId } from "./crypto.ts";

const CODE_TTL = 600;
const ACCESS_TTL = 60 * 60 * 24 * 30;

interface ClientRecord {
  kind: "client";
  redirect_uris: string[];
  name?: string;
}

interface CodeRecord {
  kind: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  nonce: string;
}

interface TokenRecord {
  kind: "access" | "refresh";
  sub: string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** RFC 9728: tells Claude which authorization server guards this resource. */
export function protectedResourceMetadata(origin: string): Response {
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["tasks"],
    bearer_methods_supported: ["header"],
  });
}

/** RFC 8414: advertises the endpoints below. */
export function authorizationServerMetadata(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: ["tasks"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  });
}

/** RFC 7591 dynamic client registration. The client id IS the record. */
export async function register(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_client_metadata" }, 400);
  }
  const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
  if (uris.length === 0) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }
  const record: ClientRecord = {
    kind: "client",
    redirect_uris: uris,
    name: typeof body.client_name === "string" ? body.client_name : undefined,
  };
  const clientId = await sign(env.SIGNING_SECRET, record, 0);
  return json({
    client_id: clientId,
    redirect_uris: uris,
    client_name: record.name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
}

function consentPage(params: Record<string, string>, error?: string): Response {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n      ");
  const message = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : `<p class="hint">Claude wants to read and change your Google Tasks.</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Google Tasks</title>
  <style>
    :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --mut:#6b6b66; --line:#e3e3df; --acc:#c45c2b; --err:#b3261e; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#161614; --fg:#f0efec; --mut:#9a9a93; --line:#2e2e2a; --acc:#e07a4a; --err:#f2857c; }
    }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
           background:var(--bg); color:var(--fg);
           font:16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .card { width:100%; max-width:380px; border:1px solid var(--line); border-radius:14px; padding:28px; }
    h1 { margin:0 0 4px; font-size:19px; letter-spacing:-0.01em; }
    .hint, .err { margin:0 0 20px; font-size:14px; }
    .hint { color:var(--mut); }
    .err { color:var(--err); }
    label { display:block; font-size:13px; color:var(--mut); margin-bottom:6px; }
    input[type=password] { width:100%; padding:10px 12px; font-size:15px; border-radius:8px;
           border:1px solid var(--line); background:transparent; color:var(--fg); }
    input[type=password]:focus { outline:2px solid var(--acc); outline-offset:1px; border-color:transparent; }
    button { width:100%; margin-top:16px; padding:11px; font-size:15px; font-weight:500;
           border:0; border-radius:8px; background:var(--acc); color:#fff; cursor:pointer; }
    button:hover { filter:brightness(1.07); }
    footer { margin-top:18px; font-size:12px; color:var(--mut); text-align:center; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect Google Tasks</h1>
    ${message}
    <form method="post" action="/authorize">
      ${hidden}
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Allow access</button>
    </form>
    <footer>gtasks-mcp</footer>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const AUTH_FIELDS = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "response_type",
] as const;

async function resolveClient(env: Env, clientId: string): Promise<ClientRecord | null> {
  const record = await verify<ClientRecord>(env.SIGNING_SECRET, clientId);
  return record && record.kind === "client" ? record : null;
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const source =
    request.method === "POST"
      ? new URLSearchParams(await request.text())
      : url.searchParams;

  const params: Record<string, string> = {};
  for (const field of AUTH_FIELDS) {
    const value = source.get(field);
    if (value !== null) params[field] = value;
  }

  const client = params.client_id ? await resolveClient(env, params.client_id) : null;
  if (!client) return json({ error: "invalid_client" }, 400);

  const redirectUri = params.redirect_uri ?? client.redirect_uris[0];
  if (!client.redirect_uris.includes(redirectUri)) {
    return json({ error: "invalid_request", error_description: "redirect_uri mismatch" }, 400);
  }
  if (params.code_challenge_method !== "S256" || !params.code_challenge) {
    return json({ error: "invalid_request", error_description: "PKCE S256 required" }, 400);
  }

  if (request.method === "GET") return consentPage(params);

  const password = source.get("password") ?? "";
  if (!safeEqual(password, env.MCP_PASSWORD)) {
    return consentPage(params, "That password did not match. Try again.");
  }

  const code = await sign(
    env.SIGNING_SECRET,
    {
      kind: "code",
      client_id: params.client_id,
      redirect_uri: redirectUri,
      code_challenge: params.code_challenge,
      nonce: randomId(),
    } satisfies CodeRecord,
    CODE_TTL,
  );

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);
  return Response.redirect(target.toString(), 302);
}

async function issueTokens(env: Env): Promise<Response> {
  const [access, refresh] = await Promise.all([
    sign(env.SIGNING_SECRET, { kind: "access", sub: "owner" } satisfies TokenRecord, ACCESS_TTL),
    sign(env.SIGNING_SECRET, { kind: "refresh", sub: "owner" } satisfies TokenRecord, 0),
  ]);
  return json({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope: "tasks",
  });
}

export async function token(request: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grant = form.get("grant_type");

  if (grant === "refresh_token") {
    const record = await verify<TokenRecord>(env.SIGNING_SECRET, form.get("refresh_token") ?? "");
    if (!record || record.kind !== "refresh") return json({ error: "invalid_grant" }, 400);
    return issueTokens(env);
  }

  if (grant !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const record = await verify<CodeRecord>(env.SIGNING_SECRET, form.get("code") ?? "");
  if (!record || record.kind !== "code") {
    return json({ error: "invalid_grant", error_description: "code invalid or expired" }, 400);
  }
  if (form.get("client_id") && form.get("client_id") !== record.client_id) {
    return json({ error: "invalid_grant", error_description: "client mismatch" }, 400);
  }
  if (form.get("redirect_uri") && form.get("redirect_uri") !== record.redirect_uri) {
    return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }
  const verifier = form.get("code_verifier");
  if (!verifier || (await s256(verifier)) !== record.code_challenge) {
    return json({ error: "invalid_grant", error_description: "PKCE check failed" }, 400);
  }
  return issueTokens(env);
}

/** Returns true when the request carries a valid access token. */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const record = await verify<TokenRecord>(env.SIGNING_SECRET, header.slice(7).trim());
  return !!record && record.kind === "access";
}

/** The 401 that kicks off the whole discovery dance. */
export function unauthorized(origin: string): Response {
  return json(
    { error: "invalid_token", error_description: "authorization required" },
    401,
    {
      "www-authenticate":
        `Bearer realm="gtasks-mcp", ` +
        `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  );
}

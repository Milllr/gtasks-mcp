import type { Env } from "./types.ts";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
  register,
  authorize,
  token,
  isAuthorized,
  unauthorized,
} from "./oauth.ts";
import { handleRpc } from "./mcp.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "86400",
};

const REQUIRED: (keyof Env)[] = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "MCP_PASSWORD",
  "SIGNING_SECRET",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const missing = REQUIRED.filter((key) => !env[key]);
    // Discovery always answers. The OAuth dance needs only the two local
    // secrets; the Google ones are not touched until a tool actually runs.
    const notConfigured = (keys: (keyof Env)[]): Response | null => {
      const gaps = keys.filter((key) => !env[key]);
      return gaps.length === 0
        ? null
        : Response.json(
            { error: "server_not_configured", missing_secrets: gaps },
            { status: 500 },
          );
    };

    // Discovery. Claude appends the resource path to the well-known lookup,
    // so both spellings are answered.
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return protectedResourceMetadata(origin);
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      return authorizationServerMetadata(origin);
    }

    if (path === "/register" || path === "/authorize" || path === "/token") {
      const gate = notConfigured(["MCP_PASSWORD", "SIGNING_SECRET"]);
      if (gate) return gate;
      if (path === "/register" && request.method === "POST") return register(request, env);
      if (path === "/authorize") return authorize(request, env);
      if (path === "/token" && request.method === "POST") return token(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/mcp") {
      const gate = notConfigured(REQUIRED);
      if (gate) return gate;
      if (!(await isAuthorized(request, env))) return unauthorized(origin);
      if (request.method === "POST") {
        const response = await handleRpc(request, env);
        for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
        return response;
      }
      // Stateless server: no server initiated stream to open.
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    if (path === "/") {
      const ready = missing.length === 0;
      return new Response(
        `gtasks-mcp\n\n` +
          `status: ${ready ? "configured" : `missing secrets: ${missing.join(", ")}`}\n` +
          `endpoint: ${origin}/mcp\n\n` +
          `Add that endpoint as a custom connector in Claude.\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** JSON-RPC handling for the MCP Streamable HTTP transport. Stateless. */
import type { Env, JsonRpcRequest } from "./types.ts";
import { TOOLS, callTool } from "./tools.ts";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED[0];

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(message: JsonRpcRequest, env: Env): Promise<object | null> {
  const { method, id } = message;
  const params = message.params ?? {};

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "gtasks-mcp", version: "1.0.0" },
        instructions:
          "Google Tasks for Miller. Lists are referred to by name, for example " +
          "'shit 2 do' or 'shit 2 buy'. Call list_task_lists first if you are unsure " +
          "which list something belongs in. delete_task and delete_task_list are " +
          "permanent, so confirm before calling them.",
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return result(id, await callTool(env, name, args));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return result(id, {
          content: [{ type: "text", text: detail }],
          isError: true,
        });
      }
    }

    default:
      if (method.startsWith("notifications/")) return null;
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleRpc(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(failure(null, -32700, "Parse error"), { status: 400 });
  }

  const batch = Array.isArray(payload) ? payload : [payload];
  const responses: object[] = [];
  for (const message of batch as JsonRpcRequest[]) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      responses.push(failure(null, -32600, "Invalid request"));
      continue;
    }
    const response = await dispatch(message, env);
    if (response) responses.push(response);
  }

  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(payload) ? responses : responses[0], {
    headers: { "cache-control": "no-store" },
  });
}

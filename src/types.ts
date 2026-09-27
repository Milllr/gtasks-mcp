export interface Env {
  /** OAuth client id from Google Cloud console. */
  GOOGLE_CLIENT_ID: string;
  /** OAuth client secret from Google Cloud console. */
  GOOGLE_CLIENT_SECRET: string;
  /** Long lived refresh token produced by scripts/get-refresh-token.mjs. */
  GOOGLE_REFRESH_TOKEN: string;
  /** Password you type on the consent screen when Claude connects. */
  MCP_PASSWORD: string;
  /** Random string used to sign client ids, auth codes and access tokens. */
  SIGNING_SECRET: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TaskList {
  id: string;
  title: string;
  updated?: string;
}

export interface Task {
  id: string;
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  due?: string;
  completed?: string;
  parent?: string;
  position?: string;
  updated?: string;
  hidden?: boolean;
  deleted?: boolean;
}

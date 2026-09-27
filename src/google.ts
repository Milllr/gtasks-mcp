/**
 * Thin Google Tasks client. The access token is cached in isolate memory, so a
 * warm Worker reuses it and a cold one spends one extra round trip. No KV.
 */
import type { Env, Task, TaskList } from "./types.ts";

const API = "https://tasks.googleapis.com/tasks/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cached: { token: string; expiresAt: number } | null = null;

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleError";
  }
}

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const payload = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !payload.access_token) {
    cached = null;
    const detail = payload.error_description ?? payload.error ?? "unknown error";
    throw new GoogleError(
      `Could not refresh the Google access token (${detail}). If this says the token was revoked or expired, re-run scripts/get-refresh-token.mjs and update the GOOGLE_REFRESH_TOKEN secret.`,
      response.status,
    );
  }

  cached = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

async function call<T>(
  env: Env,
  method: string,
  path: string,
  options: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(env)}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      /* keep the raw body */
    }
    throw new GoogleError(`Google Tasks said: ${detail}`, response.status);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function listTaskLists(env: Env): Promise<TaskList[]> {
  const data = await call<{ items?: TaskList[] }>(env, "GET", "/users/@me/lists", {
    query: { maxResults: "100" },
  });
  return data.items ?? [];
}

export function createTaskList(env: Env, title: string): Promise<TaskList> {
  return call<TaskList>(env, "POST", "/users/@me/lists", { body: { title } });
}

export function renameTaskList(env: Env, id: string, title: string): Promise<TaskList> {
  return call<TaskList>(env, "PATCH", `/users/@me/lists/${encodeURIComponent(id)}`, {
    body: { title },
  });
}

export function deleteTaskList(env: Env, id: string): Promise<void> {
  return call<void>(env, "DELETE", `/users/@me/lists/${encodeURIComponent(id)}`);
}

/**
 * Resolve a list by id, exact title, or a forgiving case and punctuation
 * insensitive match, so "shit 2 do" and "Shit 2 Do" both land.
 */
export async function resolveList(env: Env, nameOrId: string): Promise<TaskList> {
  const lists = await listTaskLists(env);
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = normalise(nameOrId);

  const match =
    lists.find((list) => list.id === nameOrId) ??
    lists.find((list) => list.title === nameOrId) ??
    lists.find((list) => normalise(list.title) === wanted) ??
    lists.find((list) => normalise(list.title).includes(wanted) && wanted.length >= 3);

  if (!match) {
    const names = lists.map((list) => `"${list.title}"`).join(", ");
    throw new GoogleError(`No task list matches "${nameOrId}". Available lists: ${names}`, 404);
  }
  return match;
}

export async function listTasks(
  env: Env,
  listId: string,
  options: { showCompleted?: boolean; showHidden?: boolean; maxResults?: number } = {},
): Promise<Task[]> {
  const data = await call<{ items?: Task[] }>(
    env,
    "GET",
    `/lists/${encodeURIComponent(listId)}/tasks`,
    {
      query: {
        maxResults: String(options.maxResults ?? 100),
        showCompleted: String(options.showCompleted ?? false),
        showHidden: String(options.showHidden ?? false),
      },
    },
  );
  return data.items ?? [];
}

export function getTask(env: Env, listId: string, taskId: string): Promise<Task> {
  return call<Task>(
    env,
    "GET",
    `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
  );
}

export function createTask(
  env: Env,
  listId: string,
  body: Partial<Task>,
  parent?: string,
): Promise<Task> {
  return call<Task>(env, "POST", `/lists/${encodeURIComponent(listId)}/tasks`, {
    query: { parent },
    body,
  });
}

export function patchTask(
  env: Env,
  listId: string,
  taskId: string,
  body: Partial<Task>,
): Promise<Task> {
  return call<Task>(
    env,
    "PATCH",
    `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { body },
  );
}

export function deleteTask(env: Env, listId: string, taskId: string): Promise<void> {
  return call<void>(
    env,
    "DELETE",
    `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
  );
}

/**
 * Google's move endpoint only reorders within a list, so a cross list move is
 * a copy followed by a delete. Done in that order: a failed delete leaves a
 * duplicate, which is recoverable, where a failed create would lose the task.
 */
export async function moveTask(
  env: Env,
  fromListId: string,
  taskId: string,
  toListId: string,
): Promise<Task> {
  const original = await getTask(env, fromListId, taskId);
  const copy = await createTask(env, toListId, {
    title: original.title,
    notes: original.notes,
    due: original.due,
    status: original.status,
    completed: original.completed,
  });
  await deleteTask(env, fromListId, taskId);
  return copy;
}

/** Normalise "today", "tomorrow", "2026-10-02" into the RFC3339 Google wants. */
export function toDueDate(value: string, timeZoneOffsetHours = -4): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "none" || trimmed === "clear") return undefined;

  const local = new Date(Date.now() + timeZoneOffsetHours * 3_600_000);
  if (trimmed === "today" || trimmed === "tomorrow") {
    if (trimmed === "tomorrow") local.setUTCDate(local.getUTCDate() + 1);
    return `${local.toISOString().slice(0, 10)}T00:00:00.000Z`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return `${trimmed}T00:00:00.000Z`;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.toISOString().slice(0, 10)}T00:00:00.000Z`;
  }
  throw new GoogleError(`Could not read "${value}" as a date. Use today, tomorrow, or YYYY-MM-DD.`, 400);
}

import type { Env, Task, ToolDefinition } from "./types.ts";
import * as g from "./google.ts";

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_task_lists",
    title: "List task lists",
    description: "Show every Google Tasks list with its id and how it is spelled.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "Show the tasks in one list. The list can be named loosely, for example 'shit 2 do'.",
    inputSchema: {
      type: "object",
      properties: {
        list: str("List name or id."),
        include_completed: bool("Include completed tasks. Defaults to false."),
      },
      required: ["list"],
    },
  },
  {
    name: "search_tasks",
    title: "Search tasks",
    description: "Search titles and notes across every list at once.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to look for, case insensitive."),
        include_completed: bool("Include completed tasks. Defaults to false."),
      },
      required: ["query"],
    },
  },
  {
    name: "create_task",
    title: "Create task",
    description: "Add a task to a list, optionally with notes, a due date, or a parent task.",
    inputSchema: {
      type: "object",
      properties: {
        list: str("List name or id."),
        title: str("The task title."),
        notes: str("Longer detail stored in the task's notes field."),
        due: str("Due date: 'today', 'tomorrow', or YYYY-MM-DD. Google ignores times."),
        parent_task_id: str("Id of an existing task, to add this as a subtask."),
      },
      required: ["list", "title"],
    },
  },
  {
    name: "update_task",
    title: "Update task",
    description: "Change a task's title, notes, due date or status.",
    inputSchema: {
      type: "object",
      properties: {
        list: str("List name or id."),
        task_id: str("Id of the task to change."),
        title: str("New title."),
        notes: str("New notes, replacing what is there."),
        due: str("New due date, or 'clear' to remove it."),
        status: { type: "string", enum: ["needsAction", "completed"], description: "New status." },
      },
      required: ["list", "task_id"],
    },
  },
  {
    name: "complete_task",
    title: "Complete task",
    description: "Tick a task off.",
    inputSchema: {
      type: "object",
      properties: { list: str("List name or id."), task_id: str("Id of the task.") },
      required: ["list", "task_id"],
    },
  },
  {
    name: "delete_task",
    title: "Delete task",
    description: "Permanently delete a task. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { list: str("List name or id."), task_id: str("Id of the task.") },
      required: ["list", "task_id"],
    },
  },
  {
    name: "move_task",
    title: "Move task between lists",
    description: "Copy a task into another list and remove it from the first.",
    inputSchema: {
      type: "object",
      properties: {
        from_list: str("Current list name or id."),
        task_id: str("Id of the task."),
        to_list: str("Destination list name or id."),
      },
      required: ["from_list", "task_id", "to_list"],
    },
  },
  {
    name: "create_task_list",
    title: "Create task list",
    description: "Make a new list.",
    inputSchema: {
      type: "object",
      properties: { title: str("Name for the new list.") },
      required: ["title"],
    },
  },
  {
    name: "rename_task_list",
    title: "Rename task list",
    description: "Rename an existing list.",
    inputSchema: {
      type: "object",
      properties: { list: str("List name or id."), title: str("New name.") },
      required: ["list", "title"],
    },
  },
  {
    name: "delete_task_list",
    title: "Delete task list",
    description: "Permanently delete a list and every task in it. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { list: str("List name or id.") },
      required: ["list"],
    },
  },
];

function renderTask(task: Task): string {
  const box = task.status === "completed" ? "[x]" : "[ ]";
  const due = task.due ? `  due ${task.due.slice(0, 10)}` : "";
  const sub = task.parent ? "    " : "  ";
  const notes = task.notes ? `\n${sub}    ${task.notes.replace(/\n/g, " ")}` : "";
  return `${sub}${box} ${task.title ?? "(untitled)"}${due}  (id: ${task.id})${notes}`;
}

function text(value: string) {
  return { content: [{ type: "text", text: value }] };
}

const S = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

export async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] }> {
  switch (name) {
    case "list_task_lists": {
      const lists = await g.listTaskLists(env);
      if (lists.length === 0) return text("You have no task lists.");
      return text(
        `${lists.length} list(s):\n` +
          lists.map((l) => `  ${l.title}  (id: ${l.id})`).join("\n"),
      );
    }

    case "list_tasks": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      const showCompleted = args.include_completed === true;
      const tasks = await g.listTasks(env, list.id, {
        showCompleted,
        showHidden: showCompleted,
      });
      if (tasks.length === 0) return text(`"${list.title}" is empty.`);
      const roots = tasks.filter((t) => !t.parent);
      const lines: string[] = [];
      for (const root of roots) {
        lines.push(renderTask(root));
        for (const child of tasks.filter((t) => t.parent === root.id)) {
          lines.push(renderTask(child));
        }
      }
      return text(`"${list.title}" (${tasks.length} task(s)):\n${lines.join("\n")}`);
    }

    case "search_tasks": {
      const query = (S(args, "query") ?? "").toLowerCase();
      const showCompleted = args.include_completed === true;
      const lists = await g.listTaskLists(env);
      const hits: string[] = [];
      for (const list of lists) {
        const tasks = await g.listTasks(env, list.id, {
          showCompleted,
          showHidden: showCompleted,
        });
        const matched = tasks.filter(
          (t) =>
            (t.title ?? "").toLowerCase().includes(query) ||
            (t.notes ?? "").toLowerCase().includes(query),
        );
        if (matched.length > 0) {
          hits.push(`"${list.title}":\n${matched.map(renderTask).join("\n")}`);
        }
      }
      return text(hits.length === 0 ? `Nothing matches "${query}".` : hits.join("\n\n"));
    }

    case "create_task": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      const due = S(args, "due");
      const created = await g.createTask(
        env,
        list.id,
        {
          title: S(args, "title"),
          notes: S(args, "notes"),
          due: due ? g.toDueDate(due) : undefined,
        },
        S(args, "parent_task_id"),
      );
      return text(
        `Added to "${list.title}":\n${renderTask(created)}`,
      );
    }

    case "update_task": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      const taskId = S(args, "task_id") ?? "";
      const due = S(args, "due");
      const body: Partial<Task> = {};
      if (S(args, "title")) body.title = S(args, "title");
      if (args.notes !== undefined) body.notes = String(args.notes ?? "");
      if (due !== undefined) body.due = g.toDueDate(due) ?? null as unknown as undefined;
      if (args.status === "completed" || args.status === "needsAction") {
        body.status = args.status;
        if (args.status === "needsAction") body.completed = null as unknown as undefined;
      }
      const updated = await g.patchTask(env, list.id, taskId, body);
      return text(`Updated in "${list.title}":\n${renderTask(updated)}`);
    }

    case "complete_task": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      const done = await g.patchTask(env, list.id, S(args, "task_id") ?? "", {
        status: "completed",
      });
      return text(`Completed in "${list.title}": ${done.title ?? "(untitled)"}`);
    }

    case "delete_task": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      const taskId = S(args, "task_id") ?? "";
      const doomed = await g.getTask(env, list.id, taskId).catch(() => null);
      await g.deleteTask(env, list.id, taskId);
      return text(
        `Deleted from "${list.title}": ${doomed?.title ?? taskId}. This cannot be undone.`,
      );
    }

    case "move_task": {
      const from = await g.resolveList(env, S(args, "from_list") ?? "");
      const to = await g.resolveList(env, S(args, "to_list") ?? "");
      const moved = await g.moveTask(env, from.id, S(args, "task_id") ?? "", to.id);
      return text(`Moved "${moved.title ?? "(untitled)"}" from "${from.title}" to "${to.title}".`);
    }

    case "create_task_list": {
      const created = await g.createTaskList(env, S(args, "title") ?? "");
      return text(`Created list "${created.title}" (id: ${created.id}).`);
    }

    case "rename_task_list": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      const renamed = await g.renameTaskList(env, list.id, S(args, "title") ?? "");
      return text(`Renamed "${list.title}" to "${renamed.title}".`);
    }

    case "delete_task_list": {
      const list = await g.resolveList(env, S(args, "list") ?? "");
      await g.deleteTaskList(env, list.id);
      return text(`Deleted the list "${list.title}" and everything in it. This cannot be undone.`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

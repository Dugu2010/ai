import { Router, Request, Response } from "express";
import {
  getProjectByUser,
  getActiveConversation,
  createConversation,
  listMessages,
  addMessage,
  getUserSettings,
} from "@dai/db";
import { NIMClient, type ToolDefinition, type ChatMessage, type ToolCall } from "@dai/nim";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { resolveNimConfig } from "../lib/nim-config.js";
import { validatePath, validateCommandOptions, MAX_TIMEOUT_MS } from "../lib/validation.js";
import { CODESANDBOX_API_KEY } from "../lib/env.js";
import { CodeSandboxClient } from "@dai/codesandbox";

const router = Router();
router.use(requireAuth);

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in a path",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to list (must start with /workspace)" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path (must start with /workspace)" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (must start with /workspace)" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact string in a file with new content. Prefer this over rewriting whole files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (must start with /workspace)" },
          oldString: { type: "string", description: "Exact text to replace (must appear exactly once ideally)" },
          newString: { type: "string", description: "Replacement text" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path (must start with /workspace)" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a file or directory",
      parameters: {
        type: "object",
        properties: {
          oldPath: { type: "string", description: "Current file path" },
          newPath: { type: "string", description: "New file path" },
        },
        required: ["oldPath", "newPath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command in the project sandbox",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run" },
          cwd: { type: "string", description: "Working directory (default: /workspace)" },
          timeoutMs: { type: "number", description: "Timeout in milliseconds (max: 300000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files by name pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "File name pattern (glob)" },
          dir: { type: "string", description: "Directory to search (default: /workspace)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description: "Search for text content in files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text pattern to find" },
          dir: { type: "string", description: "Directory to search (default: /workspace)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_dev_server",
      description: "Start (or restart) a development server and expose a public preview URL",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to start server, e.g. npm run dev" },
          port: { type: "number", description: "Port the server listens on" },
        },
        required: ["command", "port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_dev_server",
      description: "Stop the running development server",
      parameters: { type: "object", properties: {} },
    },
  },
];

const MAX_ITERATIONS = 12;

function toWireToolCalls(calls: ToolCall[]) {
  return calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
}

async function executeTool(
  client: CodeSandboxClient | null,
  name: string,
  args: Record<string, unknown>
): Promise<{ result: string; success: boolean }> {
  if (!client) {
    throw Object.assign(new Error("Sandbox is not available. The project sandbox could not be reached."), { statusCode: 503 });
  }
  try {
    switch (name) {
      case "list_files": {
        const v = validatePath(String(args.path ?? "/workspace"));
        if (!v.valid || !v.normalized) return { result: `Error: ${v.error}`, success: false };
        const entries = await client.readDir(v.normalized);
        return {
          result: JSON.stringify(entries, null, 2),
          success: true,
        };
      }
      case "read_file": {
        const v = validatePath(String(args.path ?? ""));
        if (!v.valid || !v.normalized) return { result: `Error: ${v.error}`, success: false };
        const content = await client.readFile(v.normalized);
        return content === null
          ? { result: "Error: file not found", success: false }
          : { result: content, success: true };
      }
      case "write_file": {
        const v = validatePath(String(args.path ?? ""));
        if (!v.valid || !v.normalized) return { result: `Error: ${v.error}`, success: false };
        await client.writeTextFile(v.normalized, String(args.content ?? ""));
        return { result: "File written successfully", success: true };
      }
      case "edit_file": {
        const v = validatePath(String(args.path ?? ""));
        if (!v.valid || !v.normalized) return { result: `Error: ${v.error}`, success: false };
        const oldStr = String(args.oldString ?? "");
        const newStr = String(args.newString ?? "");
        if (!oldStr) return { result: "Error: oldString is required", success: false };
        const current = await client.readFile(v.normalized);
        if (current === null) return { result: "Error: file not found", success: false };
        const first = current.indexOf(oldStr);
        if (first === -1) return { result: "Error: oldString not found in file", success: false };
        const second = current.indexOf(oldStr, first + 1);
        if (second !== -1) {
          return { result: "Error: oldString matches multiple locations; include more surrounding text", success: false };
        }
        await client.writeTextFile(v.normalized, current.slice(0, first) + newStr + current.slice(first + oldStr.length));
        return { result: "Edit applied successfully", success: true };
      }
      case "delete_file": {
        const v = validatePath(String(args.path ?? ""));
        if (!v.valid || !v.normalized) return { result: `Error: ${v.error}`, success: false };
        await client.remove(v.normalized);
        return { result: "File deleted", success: true };
      }
      case "rename_file": {
        const oldV = validatePath(String(args.oldPath ?? ""));
        const newV = validatePath(String(args.newPath ?? ""));
        if (!oldV.valid || !oldV.normalized) return { result: `Error: ${oldV.error}`, success: false };
        if (!newV.valid || !newV.normalized) return { result: `Error: ${newV.error}`, success: false };
        await client.rename(oldV.normalized, newV.normalized);
        return { result: "File renamed", success: true };
      }
      case "run_command": {
        const command = String(args.command ?? "");
        const validation = validateCommandOptions({
          command,
          cwd: args.cwd ? String(args.cwd) : undefined,
          timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
        });
        if (!validation.valid) return { result: `Error: ${validation.error}`, success: false };
        const cwdV = validatePath(String(args.cwd ?? "/workspace"));
        if (!cwdV.valid || !cwdV.normalized) return { result: `Error: ${cwdV.error}`, success: false };
        const timeout = Math.min(Number(args.timeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const r = await client.exec(command, { cwd: cwdV.normalized, timeoutMs: timeout });
        const out = [
          r.stdout ? `stdout:\n${r.stdout}` : null,
          r.stderr ? `stderr:\n${r.stderr}` : null,
          `exit code: ${r.exitCode}`,
        ]
          .filter(Boolean)
          .join("\n");
        return { result: out || "(no output)", success: r.exitCode === 0 };
      }
      case "search_files": {
        const dirV = validatePath(String(args.dir ?? "/workspace"));
        if (!dirV.valid || !dirV.normalized) return { result: `Error: ${dirV.error}`, success: false };
        const files = await client.searchFiles(dirV.normalized, String(args.pattern ?? "*"));
        return { result: files.length ? files.join("\n") : "No files matched", success: true };
      }
      case "search_content": {
        const dirV = validatePath(String(args.dir ?? "/workspace"));
        if (!dirV.valid || !dirV.normalized) return { result: `Error: ${dirV.error}`, success: false };
        const matches = await client.searchContent(dirV.normalized, String(args.pattern ?? ""));
        return {
          result: matches.length ? JSON.stringify(matches, null, 2) : "No content matched",
          success: true,
        };
      }
      case "start_dev_server": {
        const command = String(args.command ?? "");
        const port = Number(args.port ?? 3000);
        if (!command || !port || port < 1 || port > 65535) {
          return { result: "Error: command and valid port required", success: false };
        }
        await client.startDevServer("/workspace", command, port);
        const up = await client.waitForPort(port);
        const domainSuffix = process.env.DAI_PREVIEW_DOMAIN_SUFFIX || "csb.app";
        const url = await client.getPreviewUrl(port);
        return {
          result: up
            ? `Dev server is up at ${url.url}`
            : `Dev server process started at ${url.url} but the port is not answering yet — it may still be booting.`,
          success: true,
        };
      }
      case "stop_dev_server": {
        await client.stopDevServer();
        return { result: "Dev server stopped", success: true };
      }
      default:
        return { result: `Error: unknown tool ${name}`, success: false };
    }
  } catch (error: any) {
    return { result: `Error: ${error.message}`, success: false };
  }
}

function writeSSE(res: Response, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.post("/:id/agent", async (req: Request, res: Response) => {
  let codesandboxClient: CodeSandboxClient | null = null;
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { message, conversationId } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message required" });
      return;
    }

    // Bring the sandbox up BEFORE flushing the SSE headers so an unavailable
    // sandbox can be reported with a structured 503 JSON response instead of a
    // half-open stream.
    let sandboxReady = false;
    if (project.sandboxId && CODESANDBOX_API_KEY()) {
      codesandboxClient = new CodeSandboxClient(CODESANDBOX_API_KEY());
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await codesandboxClient.resumeSandbox(project.sandboxId);
          sandboxReady = true;
          break;
        } catch {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!sandboxReady) {
        res.status(503).json({ error: "Sandbox is not available. Please try again.", status: "error" });
        return;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const nimConfig = await resolveNimConfig(user.userId);
    const nim = new NIMClient(nimConfig.apiKey, nimConfig.baseURL, nimConfig.model);

    let convId: string = conversationId;
    if (!convId) {
      const existing = await getActiveConversation(project.id);
      convId = existing
        ? existing.id
        : (await createConversation(project.id, { title: "New conversation", model: nimConfig.model })).id;
    }
    const history = await listMessages(convId);

    const systemPrompt = [
      "You are DAI, an expert coding agent working inside a project sandbox.",
      "Project files live under /workspace. Use the provided tools to inspect, create, edit, and run code.",
      "Prefer edit_file for small changes and write_file for new files.",
      "Always use tools to verify state before claiming success. Be concise and practical.",
    ].join(" ");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history
        .slice(-40)
        .filter((m) => m.role === "user" || m.role === "assistant")
        // Assistant rows written for a tool-call-only turn persist a null
        // content; replaying them injects blank turns into the model's context.
        .filter((m) => m.role === "user" || (m.content ?? "").trim() !== "")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content || "" })),
      { role: "user", content: message },
    ];

    await addMessage(convId, { role: "user", content: message, projectId: project.id });

    let finalContent: string | null = null;
    let contentStreamed = false;
    const allToolCalls: { id: string; name: string; arguments: Record<string, unknown>; success: boolean; result?: string }[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await nim.chat({ messages, tools: sandboxReady ? TOOLS : undefined });

      if (response.content) {
        finalContent = response.content;
        contentStreamed = true;
        writeSSE(res, "assistant_delta", { text: response.content });
      }

      if (response.toolCalls.length === 0 || !sandboxReady) {
        break;
      }

      messages.push({
        role: "assistant",
        content: response.content ?? null,
        tool_calls: toWireToolCalls(response.toolCalls),
      });
      await addMessage(convId, {
        role: "assistant",
        content: response.content ?? null,
        projectId: project.id,
      });

      for (const call of response.toolCalls) {
        writeSSE(res, "tool_call", { id: call.id, name: call.name, args: call.arguments });

        const { result, success } = await executeTool(
          sandboxReady ? codesandboxClient : null,
          call.name,
          call.arguments
        );
        allToolCalls.push({ id: call.id, name: call.name, arguments: call.arguments, success, result: result.slice(0, 500) });

        writeSSE(res, "tool_result", {
          id: call.id,
          status: success ? "success" : "error",
          preview: result.slice(0, 200),
        });

        // Feed the tool result back to the model so it can plan the next step.
        messages.push({ role: "tool", content: result.slice(0, 8000), tool_call_id: call.id, name: call.name });

        await addMessage(convId, {
          role: "tool",
          content: result.slice(0, 8000),
          projectId: project.id,
          toolName: call.name,
          toolArgs: call.arguments,
          toolResult: { success, result: result.slice(0, 8000) },
        });
      }
    }

    if (!finalContent && allToolCalls.length > 0) {
      finalContent = `Completed ${allToolCalls.length} tool operation${allToolCalls.length === 1 ? "" : "s"}.`;
    }

    // A tool-only turn yields no prose from the model, so stream the summary:
    // without it the chat pane ends the run with no assistant message at all.
    if (finalContent && !contentStreamed) {
      writeSSE(res, "assistant_delta", { text: finalContent });
    }

    const finalMessage = await addMessage(convId, {
      role: "assistant",
      content: finalContent || "(no content returned)",
      projectId: project.id,
    });

    writeSSE(res, "done", { conversationId: convId, messageId: finalMessage.id });
    res.end();
  } catch (error: any) {
    console.error("[agent]", error.message);
    if (!res.headersSent) {
      const status = error.statusCode ?? 500;
      res.status(status).json({ error: error.message || "Agent request failed", status: "error" });
      return;
    }
    try {
      writeSSE(res, "error", { message: error.message || "Agent request failed" });
      writeSSE(res, "done", { messageId: "error" });
      res.end();
    } catch {
      // Response already broken.
    }
  }
});

export default router;

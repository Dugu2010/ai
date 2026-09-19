import { Router, Request, Response } from "express";
import {
  getProjectByUser,
  getActiveConversation,
  createConversation,
  listMessages,
  addMessage,
  getUserSettings,
  upsertUserSettings,
} from "@dai/db";
import { NIMClient, type ToolDefinition, type ChatMessage } from "@dai/nim";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { decrypt } from "../lib/crypto.js";
import { NIM_API_KEY, NIM_BASE_URL, NIM_MODEL } from "../lib/env.js";
import { validatePath, validateCommandOptions, MAX_TIMEOUT_MS } from "../lib/validation.js";
import { FREESTYLE_API_KEY } from "../lib/env.js";
import { FreestyleClient } from "@dai/freestyle";

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
      description: "Rename or move a file",
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
      description: "Execute a shell command in the project VM",
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
      description: "Start a development server and expose a preview URL",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to start server" },
          port: { type: "number", description: "Port to use" },
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

const MAX_ITERATIONS = 8;

/** Resolve NIM config: user settings first, then env defaults. */
async function resolveNimConfig(userId: string): Promise<{
  apiKey: string;
  baseURL: string;
  model: string;
}> {
  let apiKey = NIM_API_KEY();
  let baseURL = NIM_BASE_URL();
  let model = NIM_MODEL();

  const settings = await getUserSettings(userId);
  if (settings) {
    if (settings.nimApiKeyEnc) {
      const decrypted = decrypt(settings.nimApiKeyEnc);
      if (decrypted) apiKey = decrypted;
    }
    if (settings.nimBaseURL) baseURL = settings.nimBaseURL;
    if (settings.nimModel) model = settings.nimModel;
  }

  if (!apiKey) {
    throw Object.assign(
      new Error("No NIM API key available. Set NIM_API_KEY on the backend or save one in Settings."),
      { statusCode: 503 }
    );
  }
  return { apiKey, baseURL, model };
}

/** Execute one agent tool call against the Freestyle VM. */
async function executeTool(
  client: FreestyleClient,
  name: string,
  args: Record<string, unknown>
): Promise<{ result: string; success: boolean }> {
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
        return { result: out, success: r.exitCode === 0 };
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
        if (!command || !port) {
          return { result: "Error: command and port required", success: false };
        }
        await client.startDevServer("/workspace", command, port);
        const domainSuffix = process.env.DAI_PREVIEW_DOMAIN_SUFFIX || "style.dev";
        const url = await client.getPreviewUrl(port, domainSuffix);
        return { result: `Dev server started at ${url}`, success: true };
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

router.post("/:id/agent", async (req: Request, res: Response) => {
  let freestyleClient: FreestyleClient | null = null;
  let project: any = null;
  try {
    const user = getAuthUser(req);
    project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { message, conversationId } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message required" });
      return;
    }

    const nimConfig = await resolveNimConfig(user.userId);
    const nim = new NIMClient(nimConfig.apiKey, nimConfig.baseURL, nimConfig.model);

    // VM setup — needed for tools. Agent still answers chat if VM is missing.
    let vmReady = false;
    if (project.vmId && FREESTYLE_API_KEY()) {
      freestyleClient = new FreestyleClient(FREESTYLE_API_KEY());
      await freestyleClient.refVM(project.vmId);
      vmReady = true;
    }

    // Conversation
    let convId: string = conversationId;
    if (!convId) {
      const existing = await getActiveConversation(project.id);
      convId = existing ? existing.id : (await createConversation(project.id, { title: "New conversation", model: nimConfig.model })).id;
    }
    const history = await listMessages(convId);

    const systemPrompt = [
      "You are DAI, an expert coding agent working inside a project VM.",
      "Project files live under /workspace. Use the provided tools to inspect, create, edit, and run code.",
      "Always use tools to verify state before claiming success. Be concise and practical.",
      vmReady ? "" : "NOTE: The VM is not available right now; answer general questions but explain you cannot edit files.",
    ]
      .filter(Boolean)
      .join(" ");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(-50).map((m) => ({
        role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as ChatMessage["role"],
        content: m.content || "",
      })),
      { role: "user", content: message },
    ];

    await addMessage(convId, { role: "user", content: message });

    // Agentic loop
    let finalContent: string | null = null;
    let allToolCalls: any[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await nim.chat({ messages, tools: vmReady ? TOOLS : undefined });

      if (response.content) {
        finalContent = response.content;
      }

      if (response.toolCalls.length === 0 || !vmReady) {
        break;
      }

      // Execute tools
      const toolMessages: ChatMessage[] = [];
      for (const call of response.toolCalls) {
        const { result, success } = await executeTool(freestyleClient!, call.name, call.arguments);
        allToolCalls.push({ name: call.name, arguments: call.arguments, success });
        toolMessages.push({
          role: "user",
          content: `[Tool ${call.name} ${success ? "succeeded" : "failed"}]\n${result.slice(0, 4000)}`,
        });
      }
      messages.push({ role: "assistant", content: response.content || "", });
      messages.push(...toolMessages);
    }

    await addMessage(convId, {
      role: "assistant",
      content: finalContent,
      toolCalls: allToolCalls.length ? allToolCalls : undefined,
    });

    res.json({
      conversationId: convId,
      message: finalContent || "(no content returned)",
      toolCalls: allToolCalls,
    });
  } catch (error: any) {
    console.error("[agent]", error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || "Agent request failed" });
  }
});

export default router;

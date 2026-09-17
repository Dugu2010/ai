import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser, getActiveConversation, listMessages, addMessage, upsertUserSettings as updateUserSettings, getUserSettings, pool, createConversation } from "@dai/db";
import { NIMClient, ToolDefinition, ToolChoice, ChatMessage } from "@dai/nim";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

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
      description: "Execute a shell command",
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
      description: "Search for files by pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "File name pattern" },
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
          dir: { type: "string", description: "Directory to search" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Get git status for the project",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string", description: "Working directory" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Get git diff",
      parameters: {
        type: "object",
        properties: { cwd: { type: "string", description: "Working directory" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_dev_server",
      description: "Start a development server",
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
      description: "Stop the development server",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

const _agentChat = async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  try {
    const { id } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const project = await getProjectByUser(id, user.userId);
    if (!project || !project.vmId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { message, conversationId } = body;

    if (!message) {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    const apiKey = getEnv("NIM_API_KEY");
    const baseURL = getEnv("NIM_BASE_URL");
    const model = getEnv("NIM_MODEL");

    if (!apiKey) {
      return NextResponse.json({ error: "NIM_API_KEY not configured" }, { status: 500 });
    }

    const nim = new NIMClient(apiKey, baseURL, model);

    let convId = conversationId;
    if (!convId) {
      const existingConv = await getActiveConversation(id);
      if (existingConv) {
        convId = existingConv.id;
      } else {
        const newConv = await createConversation(id, { title: "New conversation", model: "deepseek-ai/deepseek-r7" });
        convId = newConv.id;
      }
    }

    const history = await listMessages(convId);

    const messages: ChatMessage[] = [
      { role: "system", content: "You are a coding assistant working on a project. The project files are located under /workspace. Use the available tools to inspect, edit, and run commands. Return results concisely. Never expose chain-of-thought." },
      ...history.slice(-50).map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content || "",
      })),
      { role: "user", content: message },
    ];

    const response = await nim.chat({ messages, tools: TOOLS });

    await addMessage(convId, {
      role: "user",
      content: message,
    });

    await addMessage(convId, {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
      usage: response.usage,
    });

    return NextResponse.json({
      conversationId: convId,
      content: response.content,
      toolCalls: response.toolCalls,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_agentChat);

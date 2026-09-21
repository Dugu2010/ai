/**
 * DAI End-to-End Test (scripts/e2e.ts)
 *
 * Verifies the full DAI pipeline:
 *   1. POST /api/projects → create project.
 *   2. Poll GET /api/workspace/:id/status until running (90s timeout).
 *   3. SSE to POST /api/projects/:id/agent → collect tool_call, tool_result,
 *      assistant_delta, and done events. Assert at least one write_file tool
 *      call succeeds.
 *   4. GET /api/workspace/:id/files → assert hello.txt exists.
 *   5. GET /api/workspace/:id/file?path=hello.txt → assert content is "hello".
 *
 * Run with: bun run tsx scripts/e2e.ts
 * Exit 0 = DAI works.
 */

interface ProjectCreateResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
}

interface StatusResponse {
  state: string;
  sandboxId: string | null;
  previewUrl: string | null;
}

interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultEvent {
  id: string;
  status: string;
  preview: string;
}

interface AssistantDeltaEvent {
  text: string;
}

interface DoneEvent {
  messageId: string;
}

interface ErrorEvent {
  message: string;
}

interface SSEEvent<T = Record<string, unknown>> {
  event: string;
  data: T;
}

const BASE_URL = process.env.DAI_API_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.DAI_AUTH_TOKEN || "";

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[e2e] FAIL: ${msg}`);
  process.exit(1);
}

async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  return res;
}

async function createProject(name: string, slug: string): Promise<ProjectCreateResponse> {
  log("Creating project...");
  const res = await apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, slug }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    fail(`POST /api/projects failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const project = (await res.json()) as ProjectCreateResponse;
  log(`Project created: ${project.id} (${project.slug})`);
  return project;
}

async function waitForRunning(projectId: string, timeoutMs = 90_000): Promise<StatusResponse> {
  log(`Polling status for project ${projectId} (timeout ${timeoutMs / 1000}s)...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await apiFetch(`/api/workspace/${projectId}/status`);
    if (res.ok) {
      const status = (await res.json()) as StatusResponse;
      if (status.state === "running") {
        log("Sandbox is RUNNING");
        return status;
      }
      log(`Status: ${status.state}, retrying in 2s...`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`Sandbox did not reach RUNNING within ${timeoutMs / 1000}s`);
}

async function streamAgentChat(projectId: string, message: string): Promise<SSEEvent[]> {
  log(`Streaming agent chat: "${message}"`);
  const events: SSEEvent[] = [];
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    fail(`POST /api/projects/${projectId}/agent failed (${res.status}): ${JSON.stringify(body)}`);
  }
  if (!res.body) {
    fail("No response body from SSE endpoint");
  }
  for await (const event of parseSSEStream(res.body) as any) {
    events.push(event);
    log(`  event: ${event.event} ${JSON.stringify(event.data).slice(0, 120)}`);
    if (event.event === "done") break;
  }
  return events;
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let event = "";
      let data = "";
      for (const line of lines) {
        if (line === "") {
          if (event || data) {
            try {
              yield { event, data: JSON.parse(data) };
            } catch {
              // Skip malformed data.
            }
            event = "";
            data = "";
          }
        } else if (line.startsWith("event: ")) {
          event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function getFiles(projectId: string): Promise<{ name: string; path: string; kind: string }[]> {
  log("Listing files...");
  const res = await apiFetch(`/api/workspace/${projectId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    fail(`GET /api/workspace/${projectId} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const files = (await res.json()) as { name: string; path: string; kind: string }[];
  log(`Files: ${files.map((f) => f.path).join(", ")}`);
  return files;
}

async function getFileContent(projectId: string, path: string): Promise<string> {
  log(`Reading ${path}...`);
  const res = await apiFetch(`/api/workspace/${projectId}/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    fail(`GET /api/workspace/${projectId}/file?path=${path} failed (${res.status})`);
  }
  const content = await res.text();
  log(`Content: "${content}"`);
  return content;
}

async function main(): Promise<void> {
  log("DAI E2E test starting...");

  // Step 1: Create project.
  const slug = `e2e-${Date.now().toString(36).slice(-6)}`;
  const project = await createProject("E2E Test", slug);

  // Step 2: Wait for sandbox to be running.
  await waitForRunning(project.id, 90_000);

  // Step 3: Stream agent chat and collect events.
  const events = await streamAgentChat(project.id, "Create hello.txt with content 'hello'.");

  // Assert events.
  const toolCallEvents = events.filter((e) => e.event === "tool_call") as SSEEvent<ToolCallEvent>[];
  const toolResultEvents = events.filter((e) => e.event === "tool_result") as SSEEvent<ToolResultEvent>[];
  const assistantDeltas = events.filter((e) => e.event === "assistant_delta") as SSEEvent<AssistantDeltaEvent>[];
  const doneEvents = events.filter((e) => e.event === "done") as SSEEvent<DoneEvent>[];

  const writeFileCalls = toolCallEvents.filter((e) => e.data.name === "write_file");
  if (writeFileCalls.length === 0) {
    fail("No tool_call event with name 'write_file' found");
  }
  log(`Found ${writeFileCalls.length} write_file tool call(s)`);

  const writeFileResults = toolResultEvents.filter((e) => {
    const call = writeFileCalls.find((c) => c.data.id === e.data.id);
    return call && e.data.status === "success";
  });
  if (writeFileResults.length === 0) {
    fail("No successful tool_result for write_file found");
  }
  log(`Found ${writeFileResults.length} successful write_file result(s)`);

  if (assistantDeltas.length === 0) {
    fail("No assistant_delta events found");
  }
  log(`Found ${assistantDeltas.length} assistant_delta event(s)`);

  if (doneEvents.length === 0) {
    fail("No done event found");
  }
  log("Found done event");

  // Step 4: Verify hello.txt exists in files.
  const files = await getFiles(project.id);
  const helloFile = files.find((f) => f.name === "hello.txt" || f.path.endsWith("/hello.txt"));
  if (!helloFile) {
    fail("hello.txt not found in workspace files");
  }
  log("hello.txt exists in workspace");

  // Step 5: Verify hello.txt content is "hello".
  const content = await getFileContent(project.id, "/workspace/hello.txt");
  if (content.trim() !== "hello") {
    fail(`hello.txt content is "${content.trim()}", expected "hello"`);
  }
  log("hello.txt content verified as 'hello'");

  log("ALL TESTS PASSED — DAI works!");
  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e] Unhandled error:", err);
  process.exit(1);
});

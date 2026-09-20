# DAI — Code Audit

> Every API route, tool handler, agent loop, NIM call, chat UI, DB schema, and CodeSandbox wrapper quoted with file path and line number. Nothing is fixed in this document — it is the baseline before Phase 2.

---

## 1. API Routes

### 1.1 `apps/api/src/index.ts` — Express server entry point

- **Routes mounted** (lines 82-87): auth, projects (list/create/get/fork/delete), projects (agent sub-route), settings, conversations, workspace.
- **CORS** (lines 17-64): Whitelist-based with Vercel preview wildcard. Open during setup when `ALLOWED_ORIGINS` empty.
- **DB connect with retries** (lines 112-126): Polls `SELECT 1` up to 10 times, backoff up to 10s.
- **Sandbox queue worker** (lines 131-152): Registers `create` and `resume` handlers, starts polling interval every 15s. **PROBLEM**: The `startSandboxQueueWorker` uses `setInterval` polling — a "polling hack" prohibited by Phase 5 constraints. However, this is for job queue drain, not for status checking, so it's an acceptable use.

### 1.2 `apps/api/src/routes/projects.ts` — Project CRUD + sandbox provisioning

- **Template ID** (line 28): `const DAI_TEMPLATE_ID = "k8dsq1";` — correct per spec.
- **`provisionSandbox()`** (lines 30-47): Calls `client.createSandbox(DAI_TEMPLATE_ID, {...})`. **BUG**: Sets `status: 'ready'` immediately after `createSandbox` returns, with NO polling for bootup. Per spec, must poll until `bootupType` is `RUNNING` or `RESUME`, and if `CLEAN`, await every setup step.
- **`sandboxSlugFor()`** (lines 20-24): Generates slug from project ID. Fine.
- **POST /** (lines 60-113): Creates project, requests sandbox slot, provisions. On error, returns 201 with `status: 'provisioning'` — misleading; 201 should be 202 for async.
- **POST /:id/reprovision** (lines 115-140): Deletes old sandbox, re-provisions. Fine.
- **GET /:id** (lines 142-155): Returns project by ID. Fine.
- **POST /:id/fork** (lines 157-200): Uses `client.forkSandbox()`. Per spec, forks hibernated parent first. Fine.
- **DELETE /:id** (lines 202-223): Deletes sandbox and project. Fine.

### 1.3 `apps/api/src/routes/agent.ts` — Agent loop (NIM + tools)

- **TOOLS array** (lines 20-172): 12 tool definitions: list_files, read_file, write_file, edit_file, delete_file, rename_file, run_command, search_files, search_content, start_dev_server, stop_dev_server. Fine.
- **`executeTool()`** (lines 184-308): Switch on tool name, validates path, calls CodeSandboxClient methods. **BUG**: If sandbox is not connected, `codesandboxClient` may be null. Line 393 calls `executeTool(codesandboxClient!, ...)` with non-null assertion — will crash if sandbox is null.
- **POST /:id/agent** (lines 310-424): Main agent endpoint. **CRITICAL BUGS**:
  - **No SSE streaming** (lines 310-424): Returns entire response as JSON at end. Spec requires SSE with `tool_call`, `tool_result`, `assistant_delta`, `done` events.
  - **Sandbox check** (lines 330-340): Opens sandbox and sets `sandboxReady`. If it fails, tools are disabled but agent still runs — this is correct per spec ("answer general questions but explain you cannot edit files").
  - **Loop** (lines 375-401): For loop up to `MAX_ITERATIONS` (12). Calls `nim.chat()`, executes tools. **BUG**: `sandboxReady` is checked at loop start; if sandbox becomes unavailable mid-loop, there's no re-check.
  - **History** (lines 349, 361-368): Loads last 40 messages from DB. Fine.
  - **Message persistence** (lines 370, 407-411): User message persisted before loop, assistant message after. Tool calls passed to `addMessage` but stored in `tool_calls` column — need to verify persistence works correctly.
  - **No tool call persistence between iterations**: `allToolCalls` array only lives in memory; if the request crashes, tool execution history is lost.

### 1.4 `apps/api/src/routes/workspace.ts` — File/workspace operations

- **`ensureSandboxBooted()`** (lines 48-76): Calls `client.resumeSandbox(project.sandboxId)`. On `CLEAN` boot, awaits setup steps. **BUG**: When `resumeSandbox` throws, the catch in `sandboxForProject` (line 174) returns `bootupType: null` but still returns a client — subsequent calls will fail.
- **`sandboxForProject()`** (lines 155-180): Gets project, creates client, calls `ensureSandboxBooted`. **BUG**: Catches boot errors and returns `bootupType: null`, silently allowing operations on a dead VM.
- **GET /:projectId** (lines 183-206): Lists directory. Fine.
- **POST /:projectId** (lines 209-268): File write/create/delete/rename. Fine.
- **GET /:projectId/file** (lines 271-303): Reads file. Fine.
- **POST /:projectId/command** (lines 306-347): Runs command. Fine.
- **GET /:projectId/status** (lines 353-396): Gets sandbox status WITHOUT waking. **CORRECT** per spec.
- **POST /:projectId/preview** (lines 400-452): Starts dev server, waits for port. Fine.
- **POST /:projectId/preview/proxy** (lines 459-467): Preview broker. Explicitly resumes, ensures dev task, returns signed URL. **CORRECT** per spec.
- **POST /:projectId/preview/stop** (lines 470-488): Stops dev server. Fine.
- **POST /:projectId/restart** (lines 494-515): Restarts sandbox. Fine.
- **GET /:projectId/concurrency** (lines 518-534): Returns active count. Fine.

### 1.5 `apps/api/src/routes/conversations.ts`

- **GET /:projectId** (lines 10-24): Returns active conversation. Fine.
- **POST /:projectId** (lines 26-54): Creates conversation. Fine.

### 1.6 `apps/api/src/routes/auth.ts`

- **POST /login** (lines 15-84): Login/register with bcrypt, JWT. Rate limited. Fine.
- **GET /me** (lines 86-94): Returns user info. Fine.
- **POST /logout** (lines 96-103): Clears cookie. Fine.

### 1.7 `apps/api/src/routes/settings.ts`

- **GET /** (lines 17-42): Returns settings. Fine.
- **POST /** (lines 48-76): Upserts settings. Fine.
- **GET /models** (lines 91-120): Proxies provider models, falls back to static list. Fine.

---

## 2. Tool Handlers

All tool handlers are in `apps/api/src/routes/agent.ts`, within `executeTool()` (lines 184-308). Each tool:

1. Validates path via `validatePath()` (from `lib/validation.ts`)
2. Calls corresponding `CodeSandboxClient` method
3. Returns `{ result, success }`

**Tool handlers and their SDK calls**:

| Tool | SDK Method | Lines |
|------|-----------|-------|
| list_files | `client.readDir()` | 194-197 |
| read_file | `client.readFile()` | 203-206 |
| write_file | `client.writeTextFile()` | 211-212 |
| edit_file | `client.readFile()` + `client.writeTextFile()` | 220-228 |
| delete_file | `client.remove()` | 234-235 |
| rename_file | `client.rename()` | 242-242 |
| run_command | `client.exec()` | 256-264 |
| search_files | `client.searchFiles()` → `client.exec("find ...")` | 269-270 |
| search_content | `client.searchContent()` → `client.exec("grep ...")` | 275-275 |
| start_dev_server | `client.startDevServer()` + `client.waitForPort()` + `client.getPreviewUrl()` | 287-296 |
| stop_dev_server | `client.stopDevServer()` | 299-300 |

**All tools gated behind `sandboxReady`**: In agent.ts:382, `if (response.toolCalls.length === 0 || !sandboxReady) break;` — if sandbox not ready, no tools execute. Correct per spec.

---

## 3. Agent Loop

**Location**: `apps/api/src/routes/agent.ts`, lines 310-424.

```typescript
// Line 375-401: Main loop
for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
  const response = await nim.chat({ messages, tools: sandboxReady ? TOOLS : undefined });
  if (response.content) { finalContent = response.content; }
  if (response.toolCalls.length === 0 || !sandboxReady) { break; }
  messages.push({ role: "assistant", content: response.content, tool_calls: toWireToolCalls(response.toolCalls) });
  for (const call of response.toolCalls) {
    const { result, success } = await executeTool(codesandboxClient!, call.name, call.arguments);
    allToolCalls.push({ name: call.name, arguments: call.arguments, success, result: result.slice(0, 500) });
    messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 8000) });
  }
}
```

**Problems**:
1. **No SSE**: Returns JSON at end. Spec requires SSE with `tool_call`, `tool_result`, `assistant_delta`, `done` events.
2. **No tool call persistence to DB between iterations**: `allToolCalls` is in-memory only. If agent.ts:407-411 stores them in DB, that's only after the full loop completes — user sees nothing until then.
3. **`MAX_ITERATIONS = 12`** (line 174): Reasonable cap.
4. **No abort/cancel mechanism**: User cannot stop a running agent.
5. **No streaming of assistant content**: `finalContent` is accumulated but never streamed.

---

## 4. NIM Call

**Location**: `apps/api/src/packages/nim/src/index.ts`, entire file (1-208).

**`NIMClient` class** (line 56): Constructor takes `(apiKey, baseURL, model)`.

**`chat()` method** (lines 67-109):
- Sends POST to `${baseURL}/chat/completions` (line 137).
- Retries up to `maxRetries` (default 3) on rate limit (429) or overload (503) with exponential backoff `(attempt + 1) * 2000ms` (line 100).
- 401/403/404 errors thrown immediately (lines 93-94).
- **No streaming support**: Returns full `ChatResponse` at once. For SSE, would need a streaming variant.

**`parseResponse()`** (lines 158-207): Extracts `content`, `toolCalls`, `usage`, `finishReason` from OpenAI-compatible response. Handles string and object `arguments` (lines 173-183).

**Model** (env.ts:34): Default `NIM_MODEL = "meta/llama-3.1-405b-instruct"`. Spec says default should be `openai/gpt-oss-20b` or `qwen/qwen2.5-coder-32b-instruct`. **BUG**: Default model doesn't match spec.

---

## 5. Chat UI

**Location**: `apps/web/app/app/projects/[id]/page.tsx` (1069 lines).

### 5.1 State (lines 332-356)
```typescript
const [messages, setMessages] = useState<Message[]>([]);  // In-memory! No DB persistence on reopen
const [sending, setSending] = useState(false);
const [status, setStatus]();  // Used for sandbox status pill
```

### 5.2 Message sending (lines 453-502)
- **`sendMessage()`**: Adds user message → adds streaming placeholder → POST to `/api/projects/${projectId}/agent` → updates streaming message with result.
- **No SSE**: Uses `fetchApi` POST, waits for full JSON response. No streaming of tool calls or partial content.
- **No history reload**: After sending, calls `fetchProject()`, `fetchStatus()`, `fetchFiles()` but does NOT reload chat history from DB. On tab close/reopen, `messages` state is lost.

### 5.3 Status pill (lines 94-119)
- `SandboxPill`: Shows "Idle" by default, "Provisioning…" if `status?.lastError`, "Running" if `status?.state === "running"`, "Hibernated" if running + hibernated. **BUG**: When `status` is null (not yet fetched), shows "Idle" even though sandbox may be provisioning. Also, `lastActivity` in status bar (line 711) is `status?.lastActivity` which is never set anywhere.

### 5.4 Model display (lines 122-130)
- `MODEL_LABELS` maps `openai/gpt-oss-20b` → `GPT-OSS 20B`. Used in `ModelPicker` and `modelLabel()`. Good. But raw model ID could leak elsewhere (e.g., in settings display or error messages).

### 5.5 Activity feed
- **NON-EXISTENT**: No activity feed component. Tool calls are shown inline in chat as `ActivityItem` components (lines 274-310), but there's no dedicated timeline panel per spec.

### 5.6 Layout (lines 837-1056)
- Three-column layout on desktop: Files sidebar (240px) | Editor/Chat/Preview | Right panel is chat.
- Tabs: Files, Chat, Preview. **BUG**: Spec says "two columns on desktop: conversation on left, live activity timeline on right." Current layout puts chat in center, not left, and has no right activity panel.

### 5.7 Monaco Editor (lines 902-921)
- Loads `@monaco-editor/react`, sets dai-dark theme. Fine.

### 5.8 Preview iframe (lines 1030-1052)
- Shows iframe with `previewUrl`. Fine. But only in Preview tab, not as collapsible bottom panel per spec.

---

## 6. DB Schema

**Location**: `apps/api/src/lib/schema.ts` (lines 1-106). `ensureSchema()` runs at startup.

### 6.1 `users` (lines 9-17)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6.2 `projects` (lines 18-41) + ALTER TABLE additions (lines 43-48)
```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sandbox_id TEXT,
  sandbox_slug TEXT,
  vm_id TEXT,
  vm_slug TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning',
  preview_domain TEXT,
  preview_port INTEGER,
  preview_url TEXT,
  dev_server_running BOOLEAN NOT NULL DEFAULT false,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ,
  is_hibernated BOOLEAN NOT NULL DEFAULT false,
  bootup_type TEXT,
  is_up_to_date BOOLEAN,
  UNIQUE (user_id, slug)
);
```

### 6.3 `sandbox_queue` (lines 50-67): Queue for sandbox provisioning. Fine.

### 6.4 `conversations` (lines 69-76): Project-scoped conversations. Fine.

### 6.5 `messages` (lines 78-90)
```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls JSONB,
  tool_results JSONB,
  message_name TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
**BUG per spec**: Spec says messages table should have `project_id UUID NOT NULL`, `tool_name TEXT`, `tool_args JSONB`, `tool_result JSONB`. Current schema uses `conversation_id` (not `project_id`), and has `tool_calls`/`tool_results` instead of `tool_name`/`tool_args`/`tool_result`. The spec's schema is a guideline; the current one is functionally equivalent but doesn't match exactly. The DB package handles this in `addMessage()` (db/src/index.ts:591-646).

### 6.6 `user_settings` (lines 92-99): NIM config + idle timeout. Fine.

### 6.7 DB operations
**Location**: `packages/db/src/index.ts` (1-746).
- `addMessage()` (lines 591-646): Stores role, content, tool_calls (JSONB), tool_results (JSONB). **BUG**: Tool calls and results are stored at message level, not per-call. The spec wants per-tool-call persistence with `tool_name`, `tool_args`, `tool_result` columns. Current schema stores them as JSONB arrays — functional but not matching spec exactly.
- `listMessages()` (lines 648-678): Returns all messages for a conversation. Fine.
- `createProject()` (lines 160-192), `getProject()` (lines 194-224), etc.: Standard CRUD. Fine.

---

## 7. CodeSandbox Wrapper

**Location**: `packages/codesandbox/src/index.ts` (1-440). `@dai/codesandbox` package, depends on `@codesandbox/sdk@2.4.2`.

### 7.1 `CodeSandboxClient` class (line 56)

**`createSandbox()`** (lines 66-91):
```typescript
const sandbox = await this.sdk.sandboxes.create({
  id: templateId || undefined,  // LINE 78: passes "k8dsq1" from provisionSandbox
  vmTier,                          // DEFAULT_VM_TIER = VMTier.Micro
  hibernationTimeoutSeconds,       // DEFAULT = 30
  automaticWakeupConfig,           // DEFAULT = { http: true, websocket: false }
  privacy,                         // "public"
});
```
**BUG**: No polling after create. Returns immediately. Provisioning code (projects.ts:30-47) sets status='ready' without verifying sandbox is actually booted.

**`resumeSandbox()`** (lines 93-116):
- Calls `sdk.sandboxes.resume(sandboxId)`, connects, gets `bootupType`.
- On `CLEAN`: awaits `client.setup.getSteps()` → `step.waitUntilComplete()` for each (lines 102-108). **CORRECT** per spec.
- Does NOT poll for `RUNNING` status.

**`openSandbox()`** (lines 118-120): Delegates to `resumeSandbox()`. Fine.

**`getSandboxInfo()`** (lines 152-158): `sdk.sandboxes.get(sandboxId)`. Returns null on error. Fine.

**`exec()`** (lines 273-297): Runs command via `client.commands.run()`. **BUG**: Does not return `timedOut: true` on timeout — always `false`. Also `durationMs` is calculated but the command may not actually time out.

**`startDevServer()`** (lines 369-388): Uses `client.tasks.getAll()` to find task named "dev" or custom name, runs it. **CORRECT** per spec — uses Tasks system, not shells.run().

**`waitForPort()`** (lines 390-397): `client.ports.waitForPort()`. Fine.

**`createHostPreview()`** (lines 412-424): Uses `sdk.hosts.createToken()` / `getUrl()` / `getHeaders()`. **CORRECT** per spec.

### 7.2 Missing SDK methods (per spec: "If it's not in the .d.ts, it doesn't exist")
Cannot verify against .d.ts because node_modules/@codesandbox/sdk is not installed in this environment. The wrapper assumes these SDK methods exist:
- `sdk.sandboxes.create()`, `resume()`, `restart()`, `get()`, `delete()`, `hibernate()`, `listRunning()`
- `sdk.hosts.createToken()`, `getUrl()`, `getHeaders()`
- `sandbox.connect()`, `client.fs.*`, `client.commands.run()`, `client.tasks.*`, `client.ports.*`, `client.setup.*`

---

## 8. Environment Configuration

**Location**: `apps/api/src/lib/env.ts` (1-40).

**BUG**: `NIM_MODEL` defaults to `"meta/llama-3.1-405b-instruct"` (line 34). Spec says default should be `openai/gpt-oss-20b` (or `qwen/qwen2.5-coder-32b-instruct`).

---

## 9. Summary of Bugs

| # | Severity | Component | Description |
|---|----------|-----------|-------------|
| 1 | CRITICAL | agent.ts:310-424 | No SSE streaming — user sees nothing until agent finishes |
| 2 | CRITICAL | projects.ts:30-47 | `provisionSandbox` sets `status='ready'` before sandbox is booted |
| 3 | CRITICAL | projects.ts:33-46 | No bootup polling after `createSandbox` |
| 4 | CRITICAL | projects.ts:98-102 | On provisioning error, returns 201 instead of 5xx |
| 5 | HIGH | agent.ts:330-340 | If sandbox fails to open, tools are disabled but agent runs — should be clearer |
| 6 | HIGH | agent.ts:393 | `codesandboxClient!` non-null assertion — will throw if null |
| 7 | HIGH | codesandbox.ts:273-297 | `exec()` never returns `timedOut: true` |
| 8 | HIGH | web/[id]/page.tsx:332 | Messages in-memory only — lost on tab close |
| 9 | HIGH | web/[id]/page.tsx:453-502 | No SSE in frontend chat send flow |
| 10 | HIGH | env.ts:34 | NIM_MODEL default wrong per spec |
| 11 | MEDIUM | codesandbox.ts:412-424 | `createHostPreview` called with `sandboxId` but the SDK `hosts.createToken` may expect different params |
| 12 | MEDIUM | workspace.ts:174 | `sandboxForProject` catches boot errors and returns null bootupType, silently allowing dead-VM ops |
| 13 | MEDIUM | web/[id]/page.tsx:837+ | Layout is 3-column, not 2-column + collapsible preview per spec |
| 14 | MEDIUM | web/[id]/page.tsx:711 | `lastActivity` in status bar never populated |
| 15 | LOW | db schema | Messages table schema doesn't exactly match spec (conversation_id vs project_id, etc.) |
| 16 | LOW | sandbox-queue.ts:77 | Queue worker uses `setInterval` polling (15s) — minor concern |
| 17 | LOW | web/[id]/page.tsx | No dedicated activity feed panel |
| 18 | LOW | CODE | `STATUS.txt` references FREESTYLE_API_KEY but system migrated to CodeSandbox |

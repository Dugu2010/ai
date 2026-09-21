> NOTE (superseded): this is a point-in-time report from an earlier runtime.
> DAI's execution runtime is now Modal Sandbox + Modal Volume. CodeSandbox and
> Freestyle have been removed; read RUNTIME_ARCHITECTURE.md and
> MODAL_RUNTIME_MIGRATION.md for the current state.

# DAI Phase 3 Progress Status

## Completed

### Packages
- **@dai/types**: Shared interfaces for User, Project, Conversation, ChatMessage, UserSettings, etc.
- **@dai/db**: Full CRUD operations for users, projects, conversations, messages, user_settings
- **@dai/freestyle**: VM client with VM lifecycle, filesystem operations, command execution, dev server management
- **@dai/nim**: NVIDIA NIM client with OpenAI-compatible API, tool calling support, retry logic
- **@dai/ui**: Basic Button component

### API Routes (apps/web/app/api)
- `/api/projects`: List all projects, create new project with VM
- `/api/projects/[id]`: Get/delete individual project
- `/api/projects/[projectId]/agent`: Agent endpoint for NIM-based task execution
- `/api/settings`: Get/update user NIM settings (encrypted API key)
- `/api/workspace/[projectId]`: List files in project workspace
- `/api/workspace/[projectId]/file`: Read file contents
- `/api/workspace/[projectId]/command`: Execute shell command
- `/api/workspace/[projectId]/preview`: Start development server
- `/api/workspace/[projectId]/status`: Get VM and preview status
- `/api/conversations/[projectId]`: Get/create conversation
- `/api/conversations/[conversationId]/messages`: List/add messages

### Web UI (apps/web)
- `/` - Project list page with create/delete functionality
- `/projects/[id]` - Project workspace with file explorer, editor, chat, and preview

### Database Schema (via migrations)
- users: id, email, name, password_hash, timestamps
- projects: id, user_id, slug, name, description, vm_id, vm_slug, status, preview info, timestamps
- conversations: id, project_id, title, model, timestamps
- messages: id, conversation_id, role, content, tool_calls, tool_results, usage, timestamps
- user_settings: user_id, nim_model, nim_base_url, nim_api_key_enc, idle_timeout_seconds

## Required Environment Variables
- DATABASE_URL: PostgreSQL connection string
- FREESTYLE_API_KEY: Freestyle cloud API key
- NIM_API_KEY: NVIDIA NIM API key
- NIM_BASE_URL: NVIDIA NIM endpoint (default: https://integrate.api.nvidia.com/v1)
- NIM_MODEL: Model to use (default: deepseek-ai/deepseek-r7)
- DAI_PREVIEW_DOMAIN_SUFFIX: Domain suffix for preview (default: style.dev)
- DAI_IDLE_TIMEOUT_SECONDS: VM idle timeout (default: 30)
- DAI_WORKSPACE_ROOT: Workspace path in VM (default: /workspace)
- JWT_SECRET: For JWT signing (required for auth)
- DAI_API_KEY_ENCRYPTION_KEY: For encrypting NIM API keys in database

## Limitations
- Build succeeds but full runtime testing requires valid API credentials
- Dev server and preview functionality depends on active Freestyle VM
- Agent requires NIM API key to be configured

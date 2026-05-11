# debug-server-remote

Remote workspace + engine management layer that wraps `debug-server-local`.

Given a `workspace_id` (or inline `content`), a `relative_path`, and an `engine` id,
`debug-server-remote` resolves file paths against persistent/ephemeral workspaces,
selects language runtimes from its registry, and delegates the actual debug
session to `debug-server-local`.

## What it knows about

- **Workspaces** — persistent and ephemeral working directories with file I/O,
  tar upload support, and inline content materialization.
- **Engines** — language-engine installation and version selection via the
  env registry under `~/.config/mchiver/debug-server-remote/registry/`.
- **Translation** — converts workspace-shaped requests into the absolute
  `file_path` + `env_vars` shape that `debug-server-local` expects.

## What it does NOT know about

- The internal debugger protocol (V8 Inspector, DAP) — that lives in
  `debug-server-local`.
- Breakpoint manipulation, call stacks, variable evaluation — delegated to
  `debug-server-local` once a session is created.

## Run

```
npm install
npm start            # full HTTP server + dashboard on :4200
npm run mcp          # MCP stdio server (workspace-aware tools)
npm run env -- install node   # install a language engine
npm test
```

## Programmatic API

```js
const { create_app } = require( '@mchiver/debug-server-remote' );
const { create_server } = require( '@mchiver/debug-server-remote/mcp' );
const WorkspaceManager = require( '@mchiver/debug-server-remote/components/WorkspaceManager' );
const Translator = require( '@mchiver/debug-server-remote/components/Translator' );
const EnvRegistry = require( '@mchiver/debug-server-remote/components/EnvRegistry' );
```

- `create_app( options )` returns `{ app, server, session_manager, workspace_manager, translator, binder, wss }`.
- `create_server( options )` returns `{ server, session_manager, workspace_manager, translator, binder, tools }` for MCP usage.
- `WorkspaceManager` — persistent/ephemeral workspace CRUD + file operations.
- `Translator` — converts workspace-shaped inputs into `debug-server-local` shape.
- `EnvRegistry` — read/scan helpers for the language-engine registry.

## API Reference

### Workspace Management

| Description | HTTP Endpoint | Request Body / Notes |
|---|---|---|
| Create a workspace | `POST /api/workspaces` | `{ name? }` |
| List workspaces | `GET /api/workspaces` | `?include_ephemeral=1` |
| Get workspace + files | `GET /api/workspaces/:id` | |
| Delete workspace | `DELETE /api/workspaces/:id` | Rejects if in use by an active session |
| Init workspace from tar | `POST /api/workspaces/:id/init` | `Content-Type: application/x-gzip` stream; `?force=1` |
| Read workspace file | `GET /api/workspaces/:id/files/*` | Returns raw bytes |
| Write workspace file | `PUT /api/workspaces/:id/files/*` | Raw body; creates intermediate dirs |
| Delete workspace file | `DELETE /api/workspaces/:id/files/*` | |

### Engine Registry

| Description | HTTP Endpoint |
|---|---|
| List installed engines | `GET /api/registry` | Returns `{ engines: [{ base, versions: [{ version_string, executable_path, broken }] }] }` |

### Session Creation (Workspace-Aware)

These routes are translated by `Translator` before delegating to `debug-server-local`.

| Description | HTTP Endpoint | MCP Tool | Extra Request Fields |
|---|---|---|---|
| Create session | `POST /api/sessions` | `create_session` | `workspace_id`, `relative_path`, `content`, `files+entry`, `engine` |
| Run and report | `POST /api/triage` | `run_and_report` | Same as above; session destroyed after run |
| Execute command in session cwd | `POST /api/sessions/:id/exec` | — | `{ command, cwd?, env_vars? }` |

### Debug Control (delegated to `debug-server-local`)

Mounted from `debug-server-local` at `/api`. See [`debug-server-local`](https://github.com/mchiver/debug-server-local) for full details.

| Description | HTTP Endpoint | MCP Tool |
|---|---|---|
| List sessions | `GET /api/sessions` | `list_sessions` |
| Get session | `GET /api/sessions/:id` | `get_session` |
| Kill session | `DELETE /api/sessions/:id` | `kill_session` |
| Restart session | `POST /api/sessions/:id/restart` | `restart_session` |
| Read output | `GET /api/sessions/:id/output` | `read_output` |
| Send input | `POST /api/sessions/:id/input` | `send_input` |
| Update settings | `POST /api/sessions/:id/settings` | `update_settings` |
| Resume | `POST /api/sessions/:id/debug/resume` | `debug_resume` |
| Step over | `POST /api/sessions/:id/debug/step_over` | `debug_step_over` |
| Step into | `POST /api/sessions/:id/debug/step_into` | `debug_step_into` |
| Step out | `POST /api/sessions/:id/debug/step_out` | `debug_step_out` |
| Get stack | `GET /api/sessions/:id/debug/stack` | `get_call_stack` |
| Get source | `GET /api/sessions/:id/source` | `get_source` |
| Get logs | `GET /api/sessions/:id/logs` | `get_logs` |
| Get variables | `GET /api/sessions/:id/debug/variables` | `get_variables` |
| Evaluate | `POST /api/sessions/:id/debug/evaluate` | `evaluate` |
| Set breakpoint | `POST /api/sessions/:id/debug/breakpoint` | `set_breakpoint` |
| Remove breakpoint | `DELETE /api/sessions/:id/debug/breakpoint/:id` | `remove_breakpoint` |
| Exception pause | `POST /api/sessions/:id/debug/exception-pause` | `set_exception_pause` |
| Set logpoint | `POST /api/sessions/:id/debug/logpoint` | `set_logpoint` |
| Get traces | `GET /api/sessions/:id/traces` | `get_traces` |
| Clear traces | `DELETE /api/sessions/:id/traces` | `clear_traces` |
| Take checkpoint | `POST /api/sessions/:id/debug/checkpoint` | `take_checkpoint` |
| List checkpoints | `GET /api/sessions/:id/debug/checkpoints` | `list_checkpoints` |
| Compare checkpoints | `GET /api/sessions/:id/debug/checkpoint_diff` | `compare_checkpoints` |

### WebSocket Events

Same as `debug-server-local`. Events are broadcast to all connected WebSocket clients.

| Event Name | When Sent |
|---|---|
| `session_list` | On client connect |
| `session_created` | After a session is created |
| `session_updated` | On any state change (excl. pause/resume) |
| `session_exited` | After a session is destroyed |
| `debugger_paused` | When execution hits a pause |
| `debugger_resumed` | When execution resumes |
| `output_update` | When new stdout/stderr is captured |

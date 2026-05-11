# WorkspaceBridge

Host/setup layer that makes a remote machine usable by `DebugBridge`.

WorkspaceBridge owns:

- **Workspaces** — persistent and ephemeral working directories with file I/O
  and tar upload support.
- **Engines** — language-engine installation and version selection
  (`node@22.5.1`, `node-tsx`, `python3`, ...) via the env registry under
  `~/.config/mchiver/debug-server-remote/registry/`.
- **Dashboard** — an AngularJS + Bootstrap UI for managing all of the above.
- **Translation** — a single `Translator` component that converts requests
  written in `{ workspace_id, relative_path, engine }` shape into the
  `{ file_path, env_vars, path_prepend }` shape that DebugBridge accepts.

DebugBridge is consumed as a library (`file:../DebugBridge`). WorkspaceBridge
mounts `DebugBridge.create_router()` at `/api`, intercepts the small set of
routes whose request bodies reference workspace paths or engine ids, and runs
them through the translator before forwarding.

## Run

```
npm install                     # pulls DebugBridge via file:../DebugBridge
npm run env -- install node     # install a language engine
npm start                       # full system on :4200, dashboard at /
npm run mcp                     # MCP stdio server (workspace-aware tools)
npm test
```

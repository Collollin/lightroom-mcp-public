# @mskalski/lightroom-mcp

MCP server bridging Claude / Codex / Cursor to Adobe Lightroom Classic via a bundled Lua plugin.

The preset round-trip tools can inspect and compare historical Develop presets, create versioned plugin-managed checkpoints from an edited representative photo, and export a preset backing file without overwriting an existing file. Plugin checkpoints are hidden from Lightroom's Develop panel by Adobe SDK design.

## Quick install

### Claude Desktop / Claude Code (one-click)

Grab the `.mcpb` from [GitHub Releases](https://github.com/Automaat/lightroom-mcp/releases/latest) and double-click. The Lightroom plugin auto-installs on first run.

### Codex CLI

```bash
codex mcp add lightroom -- npx -y @mskalski/lightroom-mcp
```

Then install the Lightroom plugin once:

```bash
npx -y @mskalski/lightroom-mcp install-plugin
```

### Cursor / Windsurf / VS Code

Add to MCP config:

```json
{
  "mcpServers": {
    "lightroom": {
      "command": "npx",
      "args": ["-y", "@mskalski/lightroom-mcp"]
    }
  }
}
```

## Commands

```
lightroom-mcp [stdio]            Run MCP over stdio (default)
lightroom-mcp install-plugin     Copy plugin into Lightroom Modules folder
```

## Docs and source

Full documentation, architecture notes, and the Lightroom plugin live at
<https://github.com/Automaat/lightroom-mcp>.

## License

MIT

## Bridge status

`get_bridge_status` takes `{}` and is available in the core toolset, including read-only mode. Degraded health returns successful tool data. Invalid arguments return a tool error.

The result contains `checkedAt`, `deadlineMs`, the local `server.version` and `server.role`, `health`, and an `owner` observation. An available owner contains its own `version`, socket `connection` evidence with `observedAt` and `generation`, a `probe` with start and finish timestamps and outcome, and runtime observations. Each observation is either `{ "kind": "available", "value": ... }` or `{ "kind": "unavailable", "reason": ... }`.

| Health | Evidence |
| --- | --- |
| `disconnected` | The owner observes either plugin socket disconnected. This does not prove Lightroom is closed. |
| `responsive` | The plugin answered the current status probe, or an older plugin answered with the recognized unknown-action error. |
| `busy` | The current status reply reports at least one active business operation, including operations waiting for Develop. Pings and status requests do not count. |
| `unresponsive` | Both plugin sockets stayed connected but the status reply exceeded the owner probe deadline. The cause is not diagnosed. |
| `unknown` | No owner is available, an owner cannot supply status, the reply is invalid, dispatch fails, or ownership or connection generation changes during the probe. |

The owner status probe uses a 1,500 ms response timer. A follower uses a 2,000 ms total broker response timer. These are event-loop timer bounds, not guarantees while the local JavaScript event loop is stalled. Status reads the current bridge role immediately, without starting or waiting for election, ordinary readiness, heartbeat probes, or the Develop queue. The normal recovery process continues independently.

`owner.value.pluginVersion` comes from the running plugin's loaded `Info.lua`. `lightroomVersion` comes from `LrApplication.versionTable()`. `catalogPath` comes from the active catalog's read-only `getPath()` getter. Each getter can fail independently. `registeredActions` lists actual dispatch names, including internal actions. It is not a promise that every action is supported by the installed Lightroom version or operating system. `activeOperations` counts plugin business handlers until completion or error, before response transmission.

Runtime metadata belongs to this probe. It is not cached across disconnects or reconnects. An older plugin can prove responsiveness without supplying metadata. An older owner that cannot answer within the broker deadline leaves owner evidence unavailable and health unknown. Local server version remains available in both cases. The tool does not edit photos, change selection or modules, switch catalogs, restart processes, or change ports.

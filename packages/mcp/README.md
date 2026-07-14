# @shader-studio/mcp

An [MCP](https://modelcontextprotocol.io) server that lets Codex, Claude Code,
Cursor, and other MCP clients drive a **locally-open Shader Studio tab**: list
shaders, edit GLSL live, tune uniforms, apply presets, and capture
screenshots — all through the same authenticated localhost WebSocket bridge
the app already exposes.

This package runs entirely on your machine. It speaks MCP over stdio to your
client and speaks a small authenticated WebSocket protocol to Shader Studio
running in your browser (or the desktop app). It never makes outbound network
calls of its own.

## Prerequisites

- Node.js (a version compatible with [Shader Studio](https://github.com/antelm-dev/shader-studio) itself — see [Version compatibility](#version-compatibility))
- Shader Studio running and reachable at `http://localhost:4200` (`pnpm dev`) or the desktop app, with a tab open
- An MCP client: [Codex](https://github.com/openai/codex), [Claude Code](https://docs.claude.com/claude-code), [Cursor](https://cursor.com), or any other MCP-compatible client

## Install & run

No install step needed — run it on demand with `npx`:

```sh
npx -y @shader-studio/mcp
```

Or install it globally:

```sh
npm install -g @shader-studio/mcp
shader-studio-mcp
```

The server prints its status to **stderr only** (stdout is reserved for the
MCP protocol itself, so your client can talk to it cleanly). On first run
with no configured token, it prints something like:

```
[shader-studio-mcp] WebSocket bridge listening on ws://127.0.0.1:4310
[shader-studio-mcp] Bridge token (auto-generated): 3f9a1c...
[shader-studio-mcp] Pair the app with this token — in the browser console, run: localStorage.setItem("shaderStudioMcpToken", "3f9a1c..."), then reload.
```

## Pairing the app

The server and the browser tab are two independent processes; the token is
what proves the tab talking to the bridge is actually your Shader Studio
session, not some other local process guessing at `127.0.0.1:4310`.

1. Start `shader-studio-mcp` (via your MCP client, or directly) and note the
   printed token — or set your own via `SHADER_STUDIO_MCP_TOKEN` (see below)
   and skip the auto-generated one entirely.
2. Open Shader Studio in your browser.
3. Open the browser devtools console and run:
   ```js
   localStorage.setItem('shaderStudioMcpToken', '<the token>');
   ```
4. Reload the page. The tab reconnects automatically and stays connected;
   only one tab may be paired at a time.

If you set `SHADER_STUDIO_MCP_TOKEN` yourself before starting the server,
skip step 1 and use that value directly in step 3.

## Security

- Binds to `127.0.0.1` by default and refuses to bind anywhere else unless
  you explicitly set `SHADER_STUDIO_MCP_HOST` — even then, `127.0.0.1` is
  not itself an authentication boundary (any local process could dial it),
  so the token handshake is what actually gates access.
- Token comparison is constant-time, so a wrong guess can't be narrowed down
  by response timing.
- A token you configure via `SHADER_STUDIO_MCP_TOKEN` is never printed back
  to logs. Only an auto-generated token is printed — once, to stderr, with
  the exact pairing instruction — since you have no other way to learn it.
- Malformed handshakes, wrong/missing tokens, incompatible protocol
  versions, a second simultaneous browser connection, and oversized messages
  are all rejected outright rather than tolerated.
- No remote/public HTTP transport exists — this is a stdio ↔ localhost
  WebSocket bridge only.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SHADER_STUDIO_MCP_PORT` | `4310` | Port for the localhost WebSocket bridge. |
| `SHADER_STUDIO_MCP_HOST` | `127.0.0.1` | Host to bind. Anything other than a loopback address is honored but logged as a warning. |
| `SHADER_STUDIO_MCP_TOKEN` | _(auto-generated)_ | Pins a token across restarts instead of generating a new one each run. |
| `SHADER_STUDIO_MCP_LOG_LEVEL` | `info` | One of `silent`, `error`, `warn`, `info`, `debug`. All output goes to stderr. |

## Troubleshooting

- **"Aucun onglet Shader Studio connecté" / no app connected** — the browser
  tab hasn't paired yet, or its token doesn't match. Re-check the pairing
  steps above; the token is regenerated every time the server restarts
  unless `SHADER_STUDIO_MCP_TOKEN` is set.
- **Port already in use** — another `shader-studio-mcp` (or the app's dev
  server on the same port) is likely already running. Set
  `SHADER_STUDIO_MCP_PORT` to a free port on both the server and whatever
  configures the app's bridge URL.
- **Protocol mismatch error** — the app and server disagree on the bridge
  wire protocol version. The rejection message names both versions and both
  component versions; update whichever side is older.
- **Nothing happens on Windows when your client runs `npx` directly** — see
  the Windows note below.

## Client examples

Set `SHADER_STUDIO_MCP_TOKEN` in your own shell/client config, not in a
committed file — none of the snippets below contain a real secret.

### Codex (`config.toml`)

```toml
[mcp_servers.shader_studio]
command = "npx"
args = ["-y", "@shader-studio/mcp"]

[mcp_servers.shader_studio.env]
SHADER_STUDIO_MCP_PORT = "4310"
SHADER_STUDIO_MCP_TOKEN = "${user-provided-secret}"
```

Codex does not expand `${...}` itself — replace it with your actual token,
kept out of version control, or omit the line entirely and use the
auto-generated token printed to stderr instead.

### Claude Code

```sh
claude mcp add shader-studio -- npx -y @shader-studio/mcp
```

To pin a token, set `SHADER_STUDIO_MCP_TOKEN` in your shell environment
before running the command, or edit the resulting entry in Claude Code's MCP
settings to add the env var there.

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "shader-studio": {
      "command": "npx",
      "args": ["-y", "@shader-studio/mcp"],
      "env": {
        "SHADER_STUDIO_MCP_PORT": "4310",
        "SHADER_STUDIO_MCP_TOKEN": "${user-provided-secret}"
      }
    }
  }
}
```

Cursor does not expand `${user-provided-secret}` either — set your real
token locally (and keep this file out of source control, or use Cursor's
per-user config location) rather than committing it.

### Windows note

Some MCP clients on Windows spawn `command` directly rather than through a
shell, which can fail to resolve `npx` (a `.cmd` shim) the same way a
terminal does. If your client can't launch the server, wrap it:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@shader-studio/mcp"]
}
```

## Development

This package lives inside the [Shader Studio](https://github.com/antelm-dev/shader-studio)
monorepo at `packages/mcp`. From the repo root:

```sh
pnpm dev:mcp        # run the server directly from source (tsx, no build step)
pnpm build:mcp       # bundle to dist/server.mjs
pnpm typecheck:mcp
pnpm test:mcp        # builds, then runs unit + integration tests
pnpm pack:mcp        # produces an installable tarball in packages/mcp/dist-pack/
```

`pnpm verify:mcp` runs a scripted round-trip against a fake "app" WebSocket
client, without needing a browser open.

## Version compatibility

- The npm package version (this `package.json`'s `version`) and the Shader
  Studio **bridge wire protocol version** are independent — the server
  reports both in any protocol-mismatch error, along with the app's own
  version, so you always know which side to update.
- This package targets the same Node.js versions as the main Shader Studio
  project (see `engines` in `package.json`).
- Always run the MCP server against a Shader Studio app from a compatible
  release; if the two drift too far apart, the handshake is rejected with an
  explicit, actionable error rather than failing silently.

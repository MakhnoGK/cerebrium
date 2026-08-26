# Cerebrium in pi

pi ships no MCP client, no rules file it manages for you, and no session-start hook. It ships
one thing instead — extensions — and that turns out to be enough for all four surfaces at once.
This directory is that extension.

```bash
npm run agent:setup -- --host pi            # what pi is missing
npm run agent:setup -- --host pi --apply    # register the extension and its launch entry
```

Restart pi (or `/reload`) afterwards.

## What it does at session start

| Surface | How pi gets it |
|---|---|
| MCP | the extension spawns `dist/server.js` over stdio and registers every tool it advertises |
| Skill | `resources_discover` hands pi this working tree's `skill/` — no symlink, no copy |
| Rules | `before_agent_start` chains `install/always-on.md` onto pi's system prompt |
| Session start | the extension calls `session_start` itself and posts the working set into the conversation |

The last row is the one worth pausing on. Every other host can only *remind* the model to call
`session_start`; here the extension holds the id it returned, so the model is handed a real
`session_id` and a working set on its first turn. When a call omits `session_id`, the bridge
fills in that same id before pi validates the arguments. It never invents one, and it never
overrides an id the model did supply.

## Tool names

Memory tools are registered with a `cerebrium_` prefix — `cerebrium_search`, `cerebrium_write`,
`cerebrium_get` — because pi already has built-in `write`, `read` and `get`. The skill and the
always-on block use the unprefixed names, and a note appended to the rules block explains the
mapping to the model.

## `/cerebrium`

| Argument | Effect |
|---|---|
| `status` (default) | launch entry in use, store, session id, tool count, `stats`, last server stderr |
| `restart` | drop the child server and reconnect, then open a fresh memory session |
| `reindex` | `code_index` for the current working directory |

`--no-cerebrium` starts pi without any of this.

## Configuration

`~/.pi/agent/cerebrium.json` holds the same `command`/`args`/`env` an `mcpServers` entry holds
for every other host, and `agent:setup --apply` writes it with the Node runtime pinned by
`.nvmrc`:

```json
{
  "command": "/path/to/node",
  "args": ["/path/to/cerebrium/dist/server.js"],
  "env": { "MEMORY_DB_PATH": "/Users/you/.cerebrium/memory.db" },
  "options": { "autoSessionId": true, "rules": true, "skill": true, "greet": true }
}
```

`options` is yours to edit and setup never rewrites it. Without the file the extension still
runs: it launches the `dist/server.js` beside itself with pi's own Node and whatever `MEMORY_*`
variables are exported, which is enough for a working tree you are developing in, and not
enough to pin a native ABI. Environment variables you exported are layered *under* the file, so
a shell export still reaches the server unless the file names the same key.

## Layout

| File | Role |
|---|---|
| `index.ts` | the extension: events, `/cerebrium`, status line |
| `client.ts` | the stdio MCP client — spawn, reconnect, call, close |
| `tools.ts` | one pi tool per MCP tool, with compact call/result rendering |
| `schema.ts` | tool naming, provider-safe schema subset, session-id filling |
| `summary.ts` | result clipping and the one-line summaries shown in the transcript |
| `config.ts` | resolving the launch entry and options |
| `rules.ts` | the always-on block, plus the pi-specific note |

Everything here is erasable TypeScript — no decorators, no parameter properties — because pi
loads it as source through jiti and `agent:setup -- --verify` loads it under
`node --experimental-strip-types` to prove the module graph is sound.

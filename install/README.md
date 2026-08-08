# Setting an agent up for Cerebrium

The end state this produces: an agent host that can call Cerebrium's tools, knows the usage
discipline, carries the retrieval precedence in context every turn, and is nudged to call
`session_start` at the beginning of a session. Four surfaces, one per weakness of the others —
[hosts.md](./hosts.md) lists where each one lives per host.

Supported hosts: **Claude Code**, **Codex CLI**, **Antigravity** (CLI and IDE share a config
root). Adding a host means adding a row to `hosts.md` and its four artifacts here — nothing in
`src/` changes, because the transport is already agent-agnostic.

## The rule this setup exists to enforce

**Nothing is copied.** The repository working tree is the single source of the doctrine; every
host reads it through a symlink or a declared path. Copies drift silently: the installed skill
once fell four tools behind the repo for three weeks, and nobody noticed until someone asked.

Two files are the source, and both live here:

- [`../skill/cerebrium/SKILL.md`](../skill/cerebrium/SKILL.md) — the deep discipline, loaded on
  demand when the agent decides it is relevant.
- [`always-on.md`](./always-on.md) — the short block that must be in context every turn.
  It carries its own `cerebrium:start` / `cerebrium:end` markers, so it can be pasted verbatim
  into a file you do not own and replaced in place later.

## The short way

```bash
npm install && npm run build
npm run agent:setup                 # what each host still needs — writes nothing
npm run agent:setup -- --apply      # install it
npm run agent:setup -- --verify     # prove it: boots the server, calls session_start
```

`--apply` writes only the surfaces the report showed as missing, re-running is a no-op,
and files you own are edited only between the `cerebrium:start`/`cerebrium:end` markers.
Add `--host codex` to work on one host, and `--force` to move an existing skill *copy*
aside (kept, never deleted) so it can be replaced by a link.

It deliberately leaves Codex's `hooks = true` under `[features]` to you because appending a
second `[features]` table would corrupt the TOML. The rest of this file is the same procedure
by hand, and the reference for what the script is doing.

## 0 — Prerequisites

```bash
npm install
npm run build
```

Node ≥ 22. One store per machine, not per repo: every host points at the same
`MEMORY_DB_PATH`. If a host is already registered, copy its environment rather than inventing
a second one — two stores means two memories, which is the failure this system exists to
prevent.

The reference registration, with the paths this repo's author uses:

| Variable | Value |
|---|---|
| `MEMORY_DB_PATH` | `$HOME/.cerebrium/memory.db` |
| `MEMORY_EMBED_PROVIDER` | `local` |
| `MEMORY_CODE_ROOTS` | `cerebrium=/ABSOLUTE/PATH/TO/cerebrium` |

`MEMORY_RERANK` and `MEMORY_CONSOLIDATE` are optional; see the Environment table in the root
[README](../README.md). Use absolute paths everywhere — a host spawns the server with its own
working directory, not yours.

## 1 — Claude Code

```bash
claude mcp add cerebrium -s user \
  --env MEMORY_DB_PATH=$HOME/.cerebrium/memory.db \
  -- node /ABSOLUTE/PATH/TO/cerebrium/dist/server.js
ln -s /ABSOLUTE/PATH/TO/cerebrium/skill/cerebrium ~/.claude/skills/cerebrium
```

Then paste `install/always-on.md` into `~/.claude/CLAUDE.md`, markers included, and add a
`SessionStart` hook to `~/.claude/settings.json` that echoes the reminder line.

Verify: `claude mcp list` shows `cerebrium`; `/mcp` in a session lists its tools.

## 2 — Codex CLI

```bash
codex mcp add cerebrium \
  --env MEMORY_DB_PATH=$HOME/.cerebrium/memory.db \
  -- node /ABSOLUTE/PATH/TO/cerebrium/dist/server.js
ln -s /ABSOLUTE/PATH/TO/cerebrium/skill/cerebrium ~/.codex/skills/cerebrium
```

Paste `always-on.md` into `~/.codex/AGENTS.md`, and add the `SessionStart` entry to
`~/.codex/hooks.json` (set `features.hooks = true` in `config.toml` if it is not already).
**Codex will prompt you to trust the hook the first time it fires — approve it there.** The
trust hash is Codex's to write, never ours.

Verify: `codex mcp list` shows `cerebrium`; `codex doctor` reports no MCP issues.

## 3 — Antigravity

Add to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "cerebrium": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/cerebrium/dist/server.js"],
      "env": { "MEMORY_DB_PATH": "/ABSOLUTE/PATH/TO/HOME/.cerebrium/memory.db" }
    }
  }
}
```

And to `~/.gemini/config/skills.json`, which takes a path instead of a copy:

```json
{ "entries": [{ "path": "/ABSOLUTE/PATH/TO/cerebrium/skill" }] }
```

Paste `always-on.md` into the global `~/.gemini/GEMINI.md`, add a `PreInvocation` hook to
`~/.gemini/config/hooks.json`, and explicitly allow the current Cerebrium tools in both active
permission files: IDE `~/.gemini/config/config.json` and CLI
`~/.gemini/antigravity-cli/settings.json`. `agent:setup -- --apply` merges these allow entries
without removing unrelated grants.

Verify: the host lists `cerebrium` under **Additional Options (…) > MCP Servers**, and asking
it to "use the cerebrium skill" loads `SKILL.md` from the working tree.

After changing rules, permissions, or the MCP bundle, restart Antigravity and start a fresh
conversation so the host rediscovers the tool catalog and runs the first-invocation hook.

## 4 — Confirm it actually works

Registration is not proof. `npm run agent:setup -- --verify` boots the built server over
stdio against a throwaway store, calls `session_start`, counts the tools it exposes, and
runs the hook script — the real memory is never opened, and it exits non-zero if any of
that fails.

That covers the server. The host's own wiring is worth ten more seconds: in a fresh
session, ask the agent to call `session_start` and report what came back. A working
install returns a `session_id` and a working set; a broken one returns a transport error.

`npm run eval:agents` summarizes persisted Antigravity IDE/CLI transcripts without printing
prompts, arguments, ids, or paths. Historical output is descriptive only. A transcript with
truncated tool calls is marked partial and all totals become observed lower bounds; controlled
scenario verdicts require fresh, labeled conversations.
The command intentionally implements no thresholds or pass/fail mode; run recall, code lookup,
write/link, and checkpoint scenarios manually in separate fresh conversations after a restart.

## Running more than one host

Each host spawns its own server process, so two hosts open at once means two writers against
one SQLite file. That is allowed, and it was measured rather than assumed: two servers doing
120 interleaved writes and searches against one store finished in 246 ms with zero errors
(p95 7 ms), and every node landed and was searchable. WAL, a 15 s busy timeout and the retry
helper serialize them; the `worker_lease` still elects a single owner for the background
roles. Invariant #1 in [CLAUDE.md](../CLAUDE.md) states the amendment and its limits.

One thing that measurement did find: two processes opening a **brand new, unmigrated** store
at the same instant used to race, and the loser died on the migration ledger's primary key.
Fixed — the ledger is now read inside the write transaction — but it is why the store should
be created once, by whichever host you set up first, before you open a second.

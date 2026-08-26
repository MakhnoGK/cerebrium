# Host surfaces

What each supported agent host exposes, and which of its surfaces Cerebrium's setup uses.
Everything here was verified against a live installation on 2026-08-09 — Claude Code, Codex,
Antigravity IDE 2.5.0, and Antigravity CLI 1.1.11 — and against pi 0.84.3 on 2026-08-26.
Re-verify before trusting it against a newer host release: these are product surfaces, not
standards.

## The four surfaces

Every host needs the same four things, and all four expose all four:

| Surface | What it does | Why it is not optional |
|---|---|---|
| MCP server | makes the 18 tools callable | without it there is no memory |
| Skill | the deep usage discipline, loaded on demand | a tool schema alone teaches nothing |
| Always-on rules | retrieval precedence, in context every turn | skills are progressively disclosed, so something must say "search memory first" |
| Session-start hook | nudges the agent to call `session_start` | a fresh session otherwise starts blind |

## Claude Code

| Surface | Location | Mechanism |
|---|---|---|
| MCP | `~/.claude.json` | `claude mcp add cerebrium -s user …` |
| Skill | `~/.claude/skills/cerebrium/` | **symlink** to this repo's `skill/cerebrium` |
| Rules | `~/.claude/CLAUDE.md` | managed block from [always-on.md](./always-on.md) |
| Hook | `~/.claude/settings.json` | `SessionStart` command hook |

## Codex CLI

| Surface | Location | Mechanism |
|---|---|---|
| MCP | `~/.codex/config.toml` (`[mcp_servers.cerebrium]`) | `codex mcp add` — do not hand-edit the TOML |
| Skill | `~/.codex/skills/cerebrium/` | **symlink** to this repo's `skill/cerebrium` |
| Rules | `~/.codex/AGENTS.md` | managed block from [always-on.md](./always-on.md) |
| Hook | `~/.codex/hooks.json` | `SessionStart`, requires `features.hooks = true` |

⚠️ **Codex hooks sit behind a trust gate.** `config.toml` carries a `[hooks.state]` entry with
a `trusted_hash` per hook, and Codex prompts before running one it has not seen. Installing the
hook file is all setup does; approving it is the user's, in Codex. Never write a `trusted_hash`
entry on the user's behalf — that is bypassing a security gate, not automating a step.

## Antigravity

Antigravity's customization system is documented by the host itself, in its built-in
`agy-customizations` skill. Global customization root: `~/.gemini/config/`, shared by the CLI
and the IDE.

| Surface | Location | Mechanism |
|---|---|---|
| MCP | `~/.gemini/config/mcp_config.json` | `mcpServers.cerebrium` entry (stdio: `command`/`args`/`env`) |
| Skill | `~/.gemini/config/skills.json` | an `entries[].path` pointing straight at this repo's `skill/` — no copy, no symlink |
| Rules | `~/.gemini/GEMINI.md` | global managed block from [always-on.md](./always-on.md) |
| Hook | `~/.gemini/config/hooks.json` | `PreInvocation` with `injectSteps[].ephemeralMessage` |
| Permissions | IDE: `~/.gemini/config/config.json`; CLI: `~/.gemini/antigravity-cli/settings.json` | explicit allow entry for each current Cerebrium tool; unrelated grants are preserved |

Every MCP registration — including pi's launch entry — uses the canonical absolute Node executable selected by this repo's
`.nvmrc`, never bare `node`. `better-sqlite3` is ABI-bound: setup checks the current Node against
`.nvmrc` and opens `:memory:` with the addon before it mutates any host config. Rerun setup after
changing/removing the NVM version or rebuilding native dependencies.

Antigravity discovers skills from `skills/<name>/SKILL.md` under a customization root **or**
from any path declared in `skills.json`. The declared path is what setup uses: it points at the
working tree, so the skill can never fall behind the repo.

The global rules file is shared across workspaces. Per-project `AGENTS.md`/`GEMINI.md` files can
still add narrower instructions, but they are no longer needed just to activate Cerebrium.

Antigravity's IDE and CLI use different permission files, so setup treats permission parity as
an Antigravity-only fifth surface. The allowlist is explicit and exhaustive: adding a new MCP
tool breaks type-checking until its permission policy is consciously classified.

## pi

pi is the exception that proves the shape: it has **no MCP client at all**, no rules file it
manages, and no session hook. What it has is extensions — TypeScript loaded from the working
tree — so all four surfaces are one artifact, [`install/pi/`](./pi/README.md).

| Surface | Location | Mechanism |
|---|---|---|
| MCP | the extension itself | spawns `dist/server.js` over stdio and registers each tool as a pi tool, prefixed `cerebrium_` |
| Skill | the extension itself | `resources_discover` returns this repo's `skill/` — no symlink, no copy |
| Rules | the extension itself | `before_agent_start` chains `install/always-on.md` onto pi's system prompt |
| Hook | the extension itself | calls `session_start` and posts the working set, so the model is handed a real `session_id` |
| Registration | `~/.pi/agent/settings.json` | `extensions[]` entry pointing at this working tree |
| Launch entry | `~/.pi/agent/cerebrium.json` | the `command`/`args`/`env` an `mcpServers` block holds elsewhere |

Two consequences worth knowing:

- pi's built-in `write`, `read` and `get` would collide, so every memory tool is registered
  with a `cerebrium_` prefix. A note appended to the rules block tells the model.
- pi validates tool arguments against the schema *before* the tool runs, so the omitted
  `session_id` is filled in `prepareArguments`, not at call time. The id is the one
  `session_start` returned in this session; the bridge never invents one.

There is no permissions surface: pi has no permission popups to grant.

## What is deliberately not used

- **Plugins** (Codex marketplaces, Antigravity `plugin.json`) — they bundle a skill, rules and
  an MCP config into one installable unit, which is the right shape for distributing Cerebrium
  to other people. It is the wrong shape for a working tree that must stay the single source of
  truth: a plugin is a copy, and a copy drifts.
- **Per-project MCP registration** — Cerebrium is one store per machine, not per repo.

## The symlink consequence

A symlinked (or path-declared) skill follows the **working tree**: whatever branch is checked
out is what every host reads. Switch back to the main line before relying on it, and do not
leave a half-written `SKILL.md` on a feature branch.

pi inherits this twice over: its extension is loaded from the working tree as source, so a
branch without `install/pi/` leaves pi with no memory tools at all, and a syntax error there
is a failed extension load rather than a stale doctrine.

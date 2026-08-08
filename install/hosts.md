# Host surfaces

What each supported agent host exposes, and which of its surfaces Cerebrium's setup uses.
Everything here was verified against a live installation on 2026-08-09 — Claude Code, Codex,
Antigravity IDE 2.5.0, and Antigravity CLI 1.1.11. Re-verify before trusting
it against a newer host release: these are product surfaces, not standards.

## The four surfaces

Every host needs the same four things, and all three expose all four:

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

Antigravity discovers skills from `skills/<name>/SKILL.md` under a customization root **or**
from any path declared in `skills.json`. The declared path is what setup uses: it points at the
working tree, so the skill can never fall behind the repo.

The global rules file is shared across workspaces. Per-project `AGENTS.md`/`GEMINI.md` files can
still add narrower instructions, but they are no longer needed just to activate Cerebrium.

Antigravity's IDE and CLI use different permission files, so setup treats permission parity as
an Antigravity-only fifth surface. The allowlist is explicit and exhaustive: adding a new MCP
tool breaks type-checking until its permission policy is consciously classified.

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

# Host surfaces

What each supported agent host exposes, and which of its surfaces Cerebrium's setup uses.
Everything here was verified against a live installation on 2026-08-07 — Claude Code, Codex
CLI 0.142.5, and Antigravity 2.0 (IDE build; see the caveat below). Re-verify before trusting
it against a newer host release: these are product surfaces, not standards.

## The four surfaces

Every host needs the same four things, and all three expose all four:

| Surface | What it does | Why it is not optional |
|---|---|---|
| MCP server | makes the 17 tools callable | without it there is no memory |
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
| Rules | `AGENTS.md` / `GEMINI.md`, walked up from cwd to repo root | managed block from [always-on.md](./always-on.md) |
| Hook | `~/.gemini/config/hooks.json` | `PreInvocation` with `injectSteps[].ephemeralMessage` |

Antigravity discovers skills from `skills/<name>/SKILL.md` under a customization root **or**
from any path declared in `skills.json`. The declared path is what setup uses: it points at the
working tree, so the skill can never fall behind the repo.

⚠️ **Rules are hierarchical, not global.** Antigravity loads `AGENTS.md`/`GEMINI.md` by walking
up from the working directory to the repo root; there is no documented machine-wide rules file.
The always-on block therefore lands per project rather than once per machine, which is the one
place where Antigravity's setup is not a single global action.

⚠️ **Only the IDE build was verified here.** Antigravity also ships a CLI front-end (its hook
docs name an `antigravity-cli/` transcript directory next to the IDE's `antigravity-ide/`). The
CLI shares `~/.gemini/config/`, so the same artifacts apply — but the CLI was not installed on
the machine where this was written, so its end-to-end behavior is inferred from the host's own
documentation, not observed.

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

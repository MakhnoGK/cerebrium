---
name: cerebrium-setup
description: >-
  Set up the agent host you are running in to use Cerebrium as durable cross-session memory —
  register the MCP server, install the usage skill, add the always-on retrieval rules, and add
  the session-start hook. Use when asked to install, wire up, configure, verify or repair
  Cerebrium for this agent (Claude Code, Codex CLI, or Antigravity), or when memory tools are
  missing in a host that should have them.
---

# Installing Cerebrium into an agent host

You are running inside an agent host, in a clone of the Cerebrium repository. Your job is to
leave that host able to use Cerebrium as memory, and to prove it before saying you are done.

## What you are installing

Four surfaces, because each covers a gap the others leave:

1. **MCP server** — makes the tools callable.
2. **Skill** — `skill/cerebrium/SKILL.md`, the usage discipline, loaded on demand.
3. **Always-on rules** — `install/always-on.md`, in context every turn.
4. **Session-start hook** — a nudge to call `session_start` before anything else.

A host with only the first one will call `write` without searching and fill the store with
duplicates. The wiring is the easy half; the doctrine is the point.

## Procedure

1. **Identify the host you are running in**, and build the bundle the hosts will launch:
   `npm install && npm run build`.
2. **Report first, then apply.** `npm run agent:setup` writes nothing and tells you exactly
   which of the four surfaces each host is missing. Then `npm run agent:setup -- --apply`
   (add `--host <id>` to limit it, `--force` only if it reports a skill *copy* in the way).
3. **Do by hand only what the report says it cannot do**, following
   [install/README.md](../../install/README.md): Codex's `hooks = true` under `[features]`,
   and Antigravity's per-project rules block. Both are explained in the report itself.
4. **Verify by calling, not by reading config.** `npm run agent:setup -- --verify` boots the
   server and calls `session_start` against a throwaway store. Then start a session on the
   host itself and call `session_start` there — that is the only thing that proves the host's
   own wiring, and it takes ten seconds.
5. **If you are in a host none of this covers**, say so and stop rather than inventing a
   layout. [hosts.md](../../install/hosts.md) records what was actually verified per host;
   adding a host means verifying its four surfaces and writing them down there.

## Boundaries

- **Never write a hook trust hash.** Codex records a `trusted_hash` per hook in `config.toml`
  and prompts the user before running an unknown one. Install the hook file and let it prompt.
  Writing that entry yourself bypasses a security gate.
- **Never touch the database.** Setup is config files and symlinks. The store is written only
  through the MCP server.
- **Never copy the skill.** Symlink it, or declare its path — the installer does this for you.
  A copy silently falls behind the repo; that has already happened once, for three weeks.
- **Never rewrite a file the user maintains.** The always-on rules go between the
  `cerebrium:start`/`cerebrium:end` markers and nowhere else.
- **Report what you could not verify.** An artifact written for a host that is not installed on
  this machine is a plausible guess, not a working install — say which is which.

## After it works

Record the setup in Cerebrium itself: which host, which surfaces, and anything about that
host's layout that differed from `hosts.md` — that difference is exactly the kind of durable
fact the next session will want, and `hosts.md` may need the correction.

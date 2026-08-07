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

1. **Identify the host you are running in.** Claude Code, Codex CLI and Antigravity each keep
   these four surfaces in different places. Do not guess a path — read
   [hosts.md](../../install/hosts.md), which records what was verified per host, and use the
   exact locations there. If you are in a host that file does not cover, say so and stop
   rather than inventing a layout.
2. **Follow [install/README.md](../../install/README.md)** for that host. It has the commands
   and the reference environment.
3. **Never copy the skill.** Symlink it, or declare its path, exactly as `hosts.md` says. A
   copy silently falls behind the repo — that has already happened once, for three weeks.
4. **Edit files you do not own only between the markers.** `install/always-on.md` ships with
   `cerebrium:start` / `cerebrium:end` markers. Insert the file verbatim; on a repeat run,
   replace what is between the markers and leave every other line of that file untouched.
   These are the user's hand-maintained instruction files.
5. **Reuse an existing registration's environment** if any host is already wired up. One store
   per machine — a second `MEMORY_DB_PATH` means a second memory, which defeats the point.
6. **Verify by calling, not by reading config.** Start a session on the host and call
   `session_start`. A `session_id` and a working set means it works; anything else means it
   does not, whatever the config file says.

## Boundaries

- **Never write a hook trust hash.** Codex records a `trusted_hash` per hook in `config.toml`
  and prompts the user before running an unknown one. Install the hook file and let it prompt.
  Writing that entry yourself bypasses a security gate.
- **Never touch the database.** Setup is config files and symlinks. The store is written only
  through the MCP server.
- **Report what you could not verify.** An artifact written for a host that is not installed on
  this machine is a plausible guess, not a working install — say which is which.

## After it works

Record the setup in Cerebrium itself: which host, which surfaces, and anything about that
host's layout that differed from `hosts.md` — that difference is exactly the kind of durable
fact the next session will want, and `hosts.md` may need the correction.

# AGENTS.md — cerebrium

## The working contract

The full contract for this repository — invariants, layering, schema rules, testing
conventions, commands — lives in [CLAUDE.md](./CLAUDE.md). It is host-neutral despite the
name: read it before changing anything here. This file exists so that hosts which discover
`AGENTS.md` rather than `CLAUDE.md` find their way to it.

Non-negotiable, in one line each, so a skim still catches them: one writer process owns the DB
file; revisions are append-only; there are no hard deletes; the FTS index is updated inside the
write transaction; tools return envelopes, not content. CLAUDE.md states each one properly.

## Setting this agent up to use Cerebrium

If you were asked to install, wire up or repair Cerebrium as memory for the agent host you are
running in, use the **`cerebrium-setup`** skill in [`skill/cerebrium-setup`](./skill/cerebrium-setup/SKILL.md),
or follow [`install/README.md`](./install/README.md) directly. Both cover Claude Code, Codex
CLI and Antigravity, and both insist on the same rule: the working tree is the single source of
the doctrine, so nothing is ever copied out of it.

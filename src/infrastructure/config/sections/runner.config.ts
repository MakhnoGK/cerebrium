import { bool, configSection, int, num, SectionOf, str } from "@/domain/ports/config";

// The runner host. Disabled by default: it is the only part of Cerebrium that spends the
// owner's subscription budget, and the budget is shared with their own interactive
// sessions — a runner at 03:00 spends what the owner needs at 09:00. Nothing arms it but
// an explicit choice.
//
// `client` is the principal the SPAWNED agent writes as, pinned through the throwaway MCP
// config the runner hands it. Give it a profile under `principals.profiles` before arming
// anything that writes; `docs/config.example.json` carries a starting point.
//
// `maxBudgetUsd` here is a per-run ceiling the task's own cap is clamped to, so a task
// cannot raise its allowance past what the deployment permits.
@configSection()
export class RunnerConfig extends SectionOf("runner", {
  enabled: bool(false).env("MEMORY_RUNNER"),
  client: str("cerebrium-runner").env("MEMORY_RUNNER_CLIENT"),
  cli: str("claude").env("MEMORY_RUNNER_CLI"),
  cwd: str("/tmp").env("MEMORY_RUNNER_CWD"),
  idleMs: int(300_000).positive().env("MEMORY_RUNNER_IDLE_MS"),
  maxBudgetUsd: num(1).env("MEMORY_RUNNER_MAX_BUDGET_USD"),
}) {}

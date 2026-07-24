import { spawn } from "node:child_process";
import {
  annotatePrompt,
  parseAnnotate,
  parseReconcile,
  parseResult,
  reconcilePrompt,
  ANNOTATE_SYSTEM_PROMPT,
  RECONCILE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  taskPrompt,
  type AnnotateResult,
  type AnnotateTask,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
  type ReconcileResult,
  type ReconcileTask,
} from "@/consolidation/provider";

// Runs a user command, feeding `input` on stdin and resolving with its stdout. Rejects
// on non-zero exit, timeout, or spawn error.
export type CommandRunner = (input: string) => Promise<string>;

// The universal "bring your own model/agent/api" adapter: the daemon pipes a task as JSON
// on stdin to a user-configured command and reads a ConsolidationResult (or the raw
// {title,summary,body} JSON) on stdout. Any failure throws → caller degrades to suggest.
// `runner` is injectable so the stdin/stdout contract is testable without spawning.
export class CommandConsolidator implements ConsolidationProvider {
  readonly name = "command";
  readonly version = "1";
  readonly enabled = true;
  private readonly runner: CommandRunner;

  constructor(opts?: { cmd?: string; timeoutMs?: number; runner?: CommandRunner }) {
    const cmd = opts?.cmd ?? process.env.MEMORY_CONSOLIDATE_CMD;
    const timeoutMs =
      opts?.timeoutMs ?? (Number(process.env.MEMORY_CONSOLIDATE_TIMEOUT_MS) || 60_000);
    this.runner = opts?.runner ?? defaultRunner(cmd, timeoutMs);
  }

  async generate(task: ConsolidationTask): Promise<ConsolidationResult> {
    const input = JSON.stringify({
      task: "consolidate",
      system: SYSTEM_PROMPT,
      kind: task.kind,
      project: task.project,
      prompt: taskPrompt(task),
      inputs: task.inputs,
    });
    return parseResult(await this.runner(input));
  }

  async reconcile(task: ReconcileTask): Promise<ReconcileResult> {
    const input = JSON.stringify({
      task: "reconcile",
      system: RECONCILE_SYSTEM_PROMPT,
      project: task.project,
      prompt: reconcilePrompt(task),
      draft: task.draft,
      candidates: task.candidates,
    });
    return parseReconcile(await this.runner(input));
  }

  async annotate(task: AnnotateTask): Promise<AnnotateResult> {
    const input = JSON.stringify({
      task: "annotate",
      system: ANNOTATE_SYSTEM_PROMPT,
      project: task.project,
      prompt: annotatePrompt(task),
      title: task.title,
      content: task.content,
    });
    return parseAnnotate(await this.runner(input));
  }
}

function defaultRunner(cmd: string | undefined, timeoutMs: number): CommandRunner {
  return (input: string) =>
    new Promise<string>((resolve, reject) => {
      if (!cmd) {
        reject(new Error("consolidation command provider: MEMORY_CONSOLIDATE_CMD is not set"));
        return;
      }
      const child = spawn(cmd, { shell: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("consolidation command provider: timed out"));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else
          reject(
            new Error(`consolidation command provider: exit ${String(code)}: ${err.slice(0, 200)}`),
          );
      });
      child.stdin.end(input);
    });
}

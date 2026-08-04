import {
  type AnnotateResult,
  type AnnotateTask,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
  type ReconcileResult,
  type ReconcileTask,
} from "@/domain/ports/consolidation-provider";
import {
  ANNOTATE_SCHEMA,
  ANNOTATE_SYSTEM_PROMPT,
  annotatePrompt,
  parseAnnotate,
  parseReconcile,
  parseResult,
  RECONCILE_SCHEMA,
  RECONCILE_SYSTEM_PROMPT,
  reconcilePrompt,
  RESULT_SCHEMA,
  SYSTEM_PROMPT,
  taskPrompt,
} from "@/consolidation/provider";

export type FetchFn = typeof fetch;

interface ChatResponse {
  message?: { content?: string };
}

// HTTP generation provider, defaulting to a local Ollama `/api/chat` with structured
// outputs (`format` = the result JSON schema) so the reply parses cleanly. Any transport
// failure, non-2xx, timeout, or malformed body throws — the caller (daemon) then degrades
// to `suggest`, exactly like the reranker's graceful fallback. `fetchFn` is injectable so
// the contract is testable offline without a live model.
// Fallbacks for a directly-constructed adapter (tests). Production values come from
// ConsolidationConfig via createConsolidator.
const DEFAULTS = {
  url: "http://127.0.0.1:11434/api/chat",
  model: "gemma4:12b-it-qat",
  timeoutMs: 500_000,
};

export class HttpConsolidator implements ConsolidationProvider {
  readonly name = "http";
  readonly version = "1";
  readonly enabled = true;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(opts?: { url?: string; model?: string; timeoutMs?: number; fetchFn?: FetchFn }) {
    this.url = opts?.url ?? DEFAULTS.url;
    this.model = opts?.model ?? DEFAULTS.model;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  async generate(task: ConsolidationTask): Promise<ConsolidationResult> {
    return parseResult(await this.chat(SYSTEM_PROMPT, taskPrompt(task), RESULT_SCHEMA));
  }

  async reconcile(task: ReconcileTask): Promise<ReconcileResult> {
    return parseReconcile(
      await this.chat(RECONCILE_SYSTEM_PROMPT, reconcilePrompt(task), RECONCILE_SCHEMA),
    );
  }

  async annotate(task: AnnotateTask): Promise<AnnotateResult> {
    return parseAnnotate(
      await this.chat(ANNOTATE_SYSTEM_PROMPT, annotatePrompt(task), ANNOTATE_SCHEMA),
    );
  }

  // One structured-output chat round-trip. Returns the raw message.content string for a
  // task-specific parser. Any transport failure, non-2xx, timeout, or malformed body
  // throws — the caller (daemon or write tool) then degrades gracefully. Every throw names
  // what went wrong, because the caller's only other signal is the absence of a proposal:
  // a timeout, a dead endpoint and a model with nothing to say look identical otherwise.
  private async chat(system: string, user: string, format: object): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format,
          options: { temperature: 0.2 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");

        throw new Error(
          `consolidation http provider: HTTP ${String(res.status)}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        );
      }
      const body = (await res.json()) as ChatResponse;
      const content = body.message?.content;
      if (typeof content !== "string") {
        throw new Error("consolidation http provider: response missing message.content");
      }
      return content;
    } catch (err) {
      // The abort surfaces as a generic DOMException, which reads like a network blip.
      // Naming the timeout is what tells an operator to raise it rather than hunt a bug.
      if (controller.signal.aborted) {
        throw new Error(
          `consolidation http provider: timed out after ${String(this.timeoutMs)}ms (MEMORY_CONSOLIDATE_TIMEOUT_MS)`,
          { cause: err },
        );
      }

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

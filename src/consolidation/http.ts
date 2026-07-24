import {
  annotatePrompt,
  parseAnnotate,
  parseReconcile,
  parseResult,
  reconcilePrompt,
  ANNOTATE_SCHEMA,
  ANNOTATE_SYSTEM_PROMPT,
  RECONCILE_SCHEMA,
  RECONCILE_SYSTEM_PROMPT,
  RESULT_SCHEMA,
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

export type FetchFn = typeof fetch;

interface ChatResponse {
  message?: { content?: string };
}

// HTTP generation provider, defaulting to a local Ollama `/api/chat` with structured
// outputs (`format` = the result JSON schema) so the reply parses cleanly. Any transport
// failure, non-2xx, timeout, or malformed body throws — the caller (daemon) then degrades
// to `suggest`, exactly like the reranker's graceful fallback. `fetchFn` is injectable so
// the contract is testable offline without a live model.
export class HttpConsolidator implements ConsolidationProvider {
  readonly name = "http";
  readonly version = "1";
  readonly enabled = true;
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(opts?: { url?: string; model?: string; timeoutMs?: number; fetchFn?: FetchFn }) {
    this.url = opts?.url ?? process.env.MEMORY_CONSOLIDATE_URL ?? "http://127.0.0.1:11434/api/chat";
    this.model = opts?.model ?? process.env.MEMORY_CONSOLIDATE_MODEL ?? "gemma4:12b-it-qat";
    this.timeoutMs =
      opts?.timeoutMs ?? (Number(process.env.MEMORY_CONSOLIDATE_TIMEOUT_MS) || 60_000);
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
  // throws — the caller (daemon or write tool) then degrades gracefully.
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
      if (!res.ok) throw new Error(`consolidation http provider: HTTP ${String(res.status)}`);
      const body = (await res.json()) as ChatResponse;
      const content = body.message?.content;
      if (typeof content !== "string") {
        throw new Error("consolidation http provider: response missing message.content");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

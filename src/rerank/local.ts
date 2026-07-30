import { homedir } from "node:os";
import { join } from "node:path";
import { type RerankProvider } from "@/domain/ports/rerank-provider";

// In-process cross-encoder reranker via transformers.js. Default model
// ms-marco-MiniLM-L-6-v2 (a BERT cross-encoder scoring a query|passage pair with a
// single relevance logit). CPU q8 is the fast path here — see the embedding-throughput
// finding: a model this small runs faster on CPU than GPU on this hardware. Model
// (~90MB) auto-downloads to MEMORY_MODEL_CACHE on first use; no API key, no daemon.
export class LocalReranker implements RerankProvider {
  readonly name: string;
  private readonly cacheDir: string;
  readonly version = "1";
  readonly enabled = true;
  private loaded: Promise<Loaded> | null = null;

  constructor(
    model = "Xenova/ms-marco-MiniLM-L-6-v2",
    cacheDir = join(homedir(), ".cerebrium", "models"),
  ) {
    this.name = model;
    this.cacheDir = cacheDir;
  }

  async rerank(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const inputs = tokenizer(new Array<string>(docs.length).fill(query), {
      text_pair: docs,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    // ms-marco cross-encoders emit one relevance logit per pair; sigmoid -> [0,1].
    return logits.tolist().map((row) => sigmoid(row[0] ?? 0));
  }

  private load(): Promise<Loaded> {
    this.loaded ??= (async () => {
      // Dynamic import keeps the heavy dep (and its model download) off any path
      // that never enables the reranker — the entire default/test configuration.
      const { AutoTokenizer, AutoModelForSequenceClassification, env } =
        await import("@huggingface/transformers");
      env.cacheDir = this.cacheDir;
      const tokenizer = (await AutoTokenizer.from_pretrained(this.name)) as unknown as Tokenizer;
      const model = (await AutoModelForSequenceClassification.from_pretrained(this.name, {
        dtype: "q8",
      })) as unknown as Model;
      return { tokenizer, model };
    })();
    return this.loaded;
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

type TokenizerOutput = Record<string, unknown>;
type Tokenizer = (
  text: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => TokenizerOutput;
type Model = (inputs: TokenizerOutput) => Promise<{ logits: { tolist(): number[][] } }>;
interface Loaded {
  tokenizer: Tokenizer;
  model: Model;
}

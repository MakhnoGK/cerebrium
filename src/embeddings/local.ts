import { type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { modelsDir } from "@/runtime/paths";

// In-process embeddings via transformers.js. Default model multilingual-e5-small
// (dim 384), using the Xenova ONNX build (identical weights, packaged with quantized
// ONNX for transformers.js). E5 is asymmetric: the "query: " / "passage: " prefixes
// are MANDATORY — dropping them silently and severely degrades similarity. Model
// files (~120MB) auto-download to MEMORY_MODEL_CACHE on first use; no API key, no daemon.
export class LocalProvider implements EmbeddingProvider {
  readonly name: string;
  private readonly cacheDir: string;
  readonly version = "1";
  readonly dim = 384;
  private pipe: Promise<FeatureExtractor> | null = null;

  constructor(model = "Xenova/multilingual-e5-small", cacheDir = modelsDir()) {
    this.name = model;
    this.cacheDir = cacheDir;
  }

  async embed(texts: string[], role: "query" | "passage"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.load();
    const prefix = role === "query" ? "query: " : "passage: ";
    const output = await pipe(
      texts.map((t) => prefix + t),
      { pooling: "mean", normalize: true },
    );
    return output.tolist();
  }

  private load(): Promise<FeatureExtractor> {
    this.pipe ??= (async () => {
      // Dynamic import keeps the heavy dep (and its model download) out of any
      // path that uses the local-null provider — the entire test suite.
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = this.cacheDir;
      return await pipeline("feature-extraction", this.name, {
        dtype: "q8",
      });
    })();
    return this.pipe;
  }
}

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

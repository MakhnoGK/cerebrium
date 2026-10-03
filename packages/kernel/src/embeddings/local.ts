import { type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { embeddingProfile, type EmbeddingProfile } from "@/embeddings/profiles";
import { modelsDir } from "@/runtime/paths";

// In-process embeddings via transformers.js, quantized ONNX builds. Model files
// auto-download to MEMORY_MODEL_CACHE on first use; no API key, no daemon.
export class LocalProvider implements EmbeddingProvider {
  readonly name: string;
  private readonly cacheDir: string;
  private readonly profile: EmbeddingProfile;
  readonly version = "1";
  readonly dim: number;
  private pipe: Promise<FeatureExtractor> | null = null;

  constructor(model = "Xenova/multilingual-e5-small", cacheDir = modelsDir()) {
    this.name = model;
    this.cacheDir = cacheDir;
    this.profile = embeddingProfile(model);
    this.dim = this.profile.dim;
  }

  async embed(texts: string[], role: "query" | "passage"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.load();
    const prefix = role === "query" ? this.profile.query : this.profile.passage;
    const output = await pipe(
      texts.map((t) => prefix + t),
      { pooling: this.profile.pooling, normalize: true },
    );
    return output.tolist();
  }

  async warm(): Promise<void> {
    await this.load();
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
  opts: { pooling: EmbeddingProfile["pooling"]; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

// How each supported model is run: its output size, how token vectors become one vector,
// and the text each side of the search is prefixed with. Pooling and prefixes are part of
// the model's contract — the wrong one still produces vectors, just useless ones.
export interface EmbeddingProfile {
  dim: number;
  pooling: "mean" | "cls" | "last_token";
  query: string;
  passage: string;
}

const E5 = { pooling: "mean", query: "query: ", passage: "passage: " } as const;

const PROFILES: Record<string, EmbeddingProfile> = {
  "Xenova/multilingual-e5-small": { dim: 384, ...E5 },
  "Xenova/multilingual-e5-large": { dim: 1024, ...E5 },
  "Xenova/bge-m3": { dim: 1024, pooling: "cls", query: "", passage: "" },
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": {
    dim: 1024,
    pooling: "last_token",
    query: "Instruct: Given a search query, retrieve the memory notes that answer it\nQuery: ",
    passage: "",
  },
};

export function embeddingProfile(model: string): EmbeddingProfile {
  const profile = PROFILES[model];

  if (!profile) {
    throw new Error(
      `no embedding profile for '${model}'; known models: ${Object.keys(PROFILES).join(", ")}`,
    );
  }

  return profile;
}

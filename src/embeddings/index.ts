import type { EmbeddingProvider } from "@/embeddings/provider";
import { VECTOR_DIM } from "@/embeddings/provider";
import { LocalNullProvider } from "@/embeddings/local-null";
import { LocalProvider } from "@/embeddings/local";

export type { EmbeddingProvider } from "@/embeddings/provider";
export { VECTOR_DIM } from "@/embeddings/provider";

export const EMBEDDING_PROVIDER_TOKEN = Symbol("EmbeddingProvider");

// Provider chosen by env at startup. Adding a paid/cloud provider is a one-file
// change here plus a class — the interface is the whole contract.
export function createProvider(
  name = process.env.MEMORY_EMBED_PROVIDER || "local",
): EmbeddingProvider {
  const provider = name === "local-null" ? new LocalNullProvider() : new LocalProvider();

  if (provider.dim !== VECTOR_DIM) {
    throw new Error(
      `Embedding provider '${provider.name}' has dim ${provider.dim}, but chunk_vec is FLOAT[${VECTOR_DIM}]. ` +
        `A dimension change needs a new vec0 table — recreate the DB or add a migration for the new dimension.`,
    );
  }

  return provider;
}

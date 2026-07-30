import { VECTOR_DIM, type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { LocalProvider } from "@/embeddings/local";
import { LocalNullProvider } from "@/embeddings/local-null";

// Provider chosen by env at startup. Adding a paid/cloud provider is a one-file
// change here plus a class — the interface is the whole contract.
export function createProvider(
  name = "local",
  model?: string,
  cacheDir?: string,
): EmbeddingProvider {
  const provider =
    name === "local-null" ? new LocalNullProvider() : new LocalProvider(model, cacheDir);

  if (provider.dim !== VECTOR_DIM) {
    throw new Error(
      `Embedding provider '${provider.name}' has dim ${provider.dim}, but chunk_vec is FLOAT[${VECTOR_DIM}]. ` +
        `A dimension change needs a new vec0 table — recreate the DB or add a migration for the new dimension.`,
    );
  }

  return provider;
}

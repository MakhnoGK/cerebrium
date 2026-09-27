export type StoreBackend = "sqlite" | "postgres";

export interface StoreCapabilities {
  // The structural code mirror (`symbols`, `code_files`, the code vector pool).
  codeIndex: boolean;
}

export const STORE_TOKEN = Symbol("Store");

// The store itself, as distinct from the repositories over it: which backend it is, a name
// that is safe to print, what it can do, and a way to release it.
export interface Store {
  readonly backend: StoreBackend;
  // A path, or a URL with its password removed. Published in the process registry.
  readonly identity: string;
  readonly capabilities: StoreCapabilities;
  // Resolves when the store answers a trivial query; rejects with why it cannot.
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class BackendCapabilityError extends Error {
  constructor(capability: string, backend: StoreBackend) {
    super(`${capability} is not available on the ${backend} backend`);
    this.name = "BackendCapabilityError";
  }
}

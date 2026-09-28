export interface PrincipalTokenRow {
  id: string;
  principal_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export const PRINCIPAL_TOKENS_REPO_TOKEN = Symbol("PrincipalTokensRepo");

// Only the hash of a token is stored. A revoked token keeps its row.
export interface PrincipalTokensRepo {
  insert(row: Omit<PrincipalTokenRow, "last_used_at" | "revoked_at">, hash: string): Promise<void>;
  findActiveByHash(hash: string): Promise<PrincipalTokenRow | undefined>;
  list(): Promise<PrincipalTokenRow[]>;
  // False when there is no such token or it was already revoked.
  revoke(id: string, ts: string): Promise<boolean>;
  touch(id: string, ts: string): Promise<void>;
}

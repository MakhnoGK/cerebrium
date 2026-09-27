import type { Writer } from "@/domain/writer";

export interface PrincipalRow {
  id: string;
  kind: string;
  label: string | null;
  created_at: string;
  last_seen: string;
}

export const PRINCIPALS_REPO_TOKEN = Symbol("PrincipalsRepo");

export interface PrincipalsRepo {
  resolve(writer: Writer, ts: string): Promise<string>;
  find(id: string): Promise<PrincipalRow | undefined>;
  list(): Promise<PrincipalRow[]>;
}

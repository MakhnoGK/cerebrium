export interface ProcessRow {
  id: string;
  role: string;
  pid: number;
  started_at: string;
  node_version: string;
  db_path: string;
  config_file: string | null;
  config_state: string;
  config_json: string;
  // Set only by a host that pre-warms an embedding model; null for roles that hold none.
  model_state: string | null;
  model_ms: number | null;
  model_error: string | null;
}

export const PROCESSES_REPO_TOKEN = Symbol("ProcessesRepo");

export interface ProcessesRepo {
  publish(row: Omit<ProcessRow, "model_state" | "model_ms" | "model_error">): Promise<void>;
  list(): Promise<ProcessRow[]>;
  recordModel(id: string, state: string, ms: number, error: string | null): Promise<void>;
  retire(ids: string[]): Promise<void>;
}

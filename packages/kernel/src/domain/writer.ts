export interface Writer {
  client: string | null;
  version: string | null;
}

export const UNKNOWN_WRITER: Writer = { client: null, version: null };

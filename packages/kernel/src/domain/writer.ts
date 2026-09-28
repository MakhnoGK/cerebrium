import type { CodeContext } from "@cerebrium/contracts/code";
import { principalIdOf } from "@cerebrium/contracts/vocab";

export interface Writer {
  client: string | null;
  version: string | null;
  // Set by the transport from an authenticated token; the client name cannot override it.
  principal?: string | null;
  // The caller's repo and branch, from the transport. Never taken from a call's arguments.
  code?: CodeContext | null;
}

export const UNKNOWN_WRITER: Writer = { client: null, version: null };

export function principalOfWriter(writer: Writer): string {
  return writer.principal ?? principalIdOf(writer.client);
}

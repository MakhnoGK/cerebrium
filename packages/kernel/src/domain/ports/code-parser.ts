import type { UnitParse } from "@/domain/ports/storage";

export const CODE_PARSER_TOKEN = Symbol("CodeParser");

export type ParseOutcome = { ok: true; parse: UnitParse } | { ok: false; error: string };

// Turns a file's content into symbols and unresolved refs. The daemon backs it with a worker
// thread so a large upload never parses on the thread that answers the socket.
export interface CodeParser {
  parse(units: { path: string; content: string }[]): Promise<ParseOutcome[]>;
  close(): Promise<void>;
}

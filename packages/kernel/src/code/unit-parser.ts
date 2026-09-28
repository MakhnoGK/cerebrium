import { langForPath } from "@cerebrium/contracts/code";
import type { CodeParser, ParseOutcome } from "@/domain/ports/code-parser";
import type { UnitParse } from "@/domain/ports/storage";
import { extractFile } from "@/code/extract";
import { parse } from "@/code/parser";

export async function parseUnit(path: string, content: string): Promise<UnitParse> {
  const def = langForPath(path);

  if (!def) throw new Error(`no grammar for ${path}`);

  const tree = await parse(def.wasm, content, def.vendored ?? false);

  try {
    const extract = extractFile("", path, def.lang, content, tree.rootNode);

    return {
      symbols: extract.symbols,
      defines: extract.defines,
      imports: extract.imports,
      calls: extract.calls,
    };
  } finally {
    tree.delete();
  }
}

export async function parseUnits(
  units: { path: string; content: string }[],
): Promise<ParseOutcome[]> {
  const out: ParseOutcome[] = [];

  for (const unit of units) {
    try {
      out.push({ ok: true, parse: await parseUnit(unit.path, unit.content) });
    } catch (err) {
      out.push({ ok: false, error: (err as Error).message || String(err) });
    }
  }

  return out;
}

export class InProcessCodeParser implements CodeParser {
  parse(units: { path: string; content: string }[]): Promise<ParseOutcome[]> {
    return parseUnits(units);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

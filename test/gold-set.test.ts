import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendGold,
  countByOrigin,
  filterByOrigin,
  parseGoldLine,
  parseOrigins,
  pruneStale,
  readGoldFile,
  toEvalQueries,
  type GoldEntry,
} from "@scripts/gold";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

function entry(over: Partial<GoldEntry> = {}): GoldEntry {
  return { query: "how does the lease renew", gold: ["n1"], origin: "generated", ...over };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gold-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseGoldLine", () => {
  it("should parse an entry with its section labels", () => {
    // Given / When
    const parsed = parseGoldLine(
      JSON.stringify({
        query: "what renews the lease",
        gold: ["n1"],
        origin: "adjudicated",
        sections: { n1: ["H2: Lease"] },
      }),
    );

    // Then
    expect(parsed).toMatchObject({ query: "what renews the lease", gold: ["n1"] });
    expect(parsed!.sections).toEqual({ n1: ["H2: Lease"] });
  });

  it("should return null when the line is truncated", () => {
    // Given / When
    const parsed = parseGoldLine('{"query":"half a li');

    // Then
    expect(parsed).toBeNull();
  });

  it("should return null when the entry carries no usable label", () => {
    // Given / When / Then
    expect(parseGoldLine(JSON.stringify({ query: "q", gold: [], origin: "generated" }))).toBeNull();
    expect(
      parseGoldLine(JSON.stringify({ query: "", gold: ["n1"], origin: "generated" })),
    ).toBeNull();
    expect(
      parseGoldLine(JSON.stringify({ query: "q", gold: ["n1"], origin: "guessed" })),
    ).toBeNull();
  });
});

describe("readGoldFile", () => {
  it("should keep the good lines and count the bad ones when a run was interrupted", () => {
    // Given
    const path = join(dir, "gold.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(entry()),
        "",
        JSON.stringify(entry({ query: "second" })),
        '{"query":"tru',
      ].join("\n"),
    );

    // When
    const { entries, malformed } = readGoldFile(path);

    // Then
    expect(entries).toHaveLength(2);
    expect(malformed).toBe(1);
  });

  it("should read back what append wrote", () => {
    // Given
    const path = join(dir, "gold.jsonl");

    // When
    appendGold(path, [entry()]);
    appendGold(path, [entry({ query: "second", origin: "mined" })]);

    // Then
    const { entries } = readGoldFile(path);
    expect(entries.map((e) => e.origin)).toEqual(["generated", "mined"]);
  });

  it("should return an empty set when the file does not exist yet", () => {
    // Given / When
    const { entries, malformed } = readGoldFile(join(dir, "absent.jsonl"));

    // Then
    expect(entries).toEqual([]);
    expect(malformed).toBe(0);
  });
});

describe("pruneStale", () => {
  it("should drop a label whose node is no longer live", () => {
    // Given
    const entries = [entry({ gold: ["live", "dead"], sections: { dead: ["H2: Gone"] } })];

    // When
    const { kept, droppedLabels, droppedQueries } = pruneStale(entries, (id) => id === "live");

    // Then
    expect(kept[0]!.gold).toEqual(["live"]);
    expect(kept[0]!.sections).toEqual({});
    expect(droppedLabels).toBe(1);
    expect(droppedQueries).toBe(0);
  });

  it("should drop the query entirely when nothing it points at survives", () => {
    // Given
    const entries = [entry({ gold: ["dead"] }), entry({ query: "other", gold: ["live"] })];

    // When
    const { kept, droppedQueries } = pruneStale(entries, (id) => id === "live");

    // Then
    expect(kept).toHaveLength(1);
    expect(droppedQueries).toBe(1);
  });
});

describe("toEvalQueries", () => {
  it("should merge one question asked by two sources into a single scored query", () => {
    // Given
    const entries = [
      entry({ query: "How does the lease renew?", gold: ["n1"], origin: "generated" }),
      entry({ query: "how does the   lease renew?  ", gold: ["n2"], origin: "adjudicated" }),
    ];

    // When
    const queries = toEvalQueries(entries);

    // Then
    expect(queries).toHaveLength(1);
    expect([...queries[0]!.gold]).toEqual(["n1", "n2"]);
    expect([...queries[0]!.origins]).toEqual(["generated", "adjudicated"]);
  });

  it("should union the section labels of the merged entries", () => {
    // Given
    const entries = [
      entry({ sections: { n1: ["H2: Lease"] } }),
      entry({ sections: { n1: ["H2: Renewal"] } }),
    ];

    // When
    const [query] = toEvalQueries(entries);

    // Then
    expect([...query!.sections!.get("n1")!]).toEqual(["H2: Lease", "H2: Renewal"]);
  });
});

describe("Origin filtering", () => {
  it("should keep every entry when no origin is named", () => {
    // Given
    const entries = [entry(), entry({ origin: "mined" })];

    // When / Then
    expect(filterByOrigin(entries, parseOrigins(undefined))).toHaveLength(2);
    expect(filterByOrigin(entries, parseOrigins("mined"))).toHaveLength(1);
  });

  it("should ignore an origin that is not part of the vocabulary", () => {
    // Given / When
    const origins = parseOrigins("mined,invented");

    // Then
    expect([...origins]).toEqual(["mined"]);
  });

  it("should count the entries per origin", () => {
    // Given / When
    const counts = countByOrigin([entry(), entry(), entry({ origin: "adjudicated" })]);

    // Then
    expect(counts).toEqual({ generated: 2, adjudicated: 1, mined: 0 });
  });
});

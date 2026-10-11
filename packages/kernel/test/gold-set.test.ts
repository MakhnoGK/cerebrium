import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ageBucket,
  appendGold,
  countByOrigin,
  filterByOrigin,
  lexicalOverlap,
  liveAt,
  parseGoldLine,
  parseOrigins,
  pruneStale,
  queryAge,
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

describe("liveAt", () => {
  const span = { created: "2026-08-10T00:00:00.000Z", invalidated: "2026-09-10T00:00:00.000Z" };

  it("should count a node live between its creation and its retirement", () => {
    // Given / When / Then
    expect(liveAt(span, "2026-08-01T00:00:00.000Z")).toBe(false);
    expect(liveAt(span, "2026-08-10T00:00:00.000Z")).toBe(true);
    expect(liveAt(span, "2026-09-10T00:00:00.000Z")).toBe(false);
  });

  it("should read no horizon as today", () => {
    // Given / When / Then
    expect(liveAt(span, undefined)).toBe(false);
    expect(liveAt({ ...span, invalidated: null }, undefined)).toBe(true);
    expect(liveAt(undefined, undefined)).toBe(false);
  });
});

describe("queryAge", () => {
  const spans = new Map([
    ["old", { created: "2026-06-01T00:00:00.000Z", invalidated: null }],
    ["mid", { created: "2026-09-20T00:00:00.000Z", invalidated: null }],
    ["new", { created: "2026-10-09T00:00:00.000Z", invalidated: null }],
  ]);
  const at = "2026-10-11T00:00:00.000Z";

  it("should bucket a query by its youngest answer", () => {
    // Given / When / Then
    expect(queryAge(["old"], spans, at)).toBe(">90d");
    expect(queryAge(["old", "mid"], spans, at)).toBe("7-30d");
    expect(queryAge(["old", "new"], spans, at)).toBe("<7d");
  });

  it("should leave a query unbucketed when none of its answers is known", () => {
    // Given / When / Then
    expect(queryAge(["ghost"], spans, at)).toBeUndefined();
  });

  it("should put a boundary age in the older bucket", () => {
    // Given / When / Then
    expect(ageBucket("2026-10-04T00:00:00.000Z", at)).toBe("7-30d");
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

describe("lexicalOverlap", () => {
  const section =
    "The consolidation worker claims a lease per tick at a hardcoded sixty second TTL and " +
    "never renews it, so a long generation call expires the lease mid sweep.";

  it("should score a question that echoes its section near one", () => {
    // Given / When
    const overlap = lexicalOverlap(
      "What TTL does the consolidation worker lease claim per tick?",
      section,
    );

    // Then
    expect(overlap).toBeGreaterThan(0.8);
  });

  it("should score a paraphrased question well below the echo threshold", () => {
    // Given / When
    const overlap = lexicalOverlap(
      "What makes a background job lose its exclusive claim while a slow model reply is pending?",
      section,
    );

    // Then
    expect(overlap).toBeLessThan(0.5);
  });

  it("should treat a question with no content words as an echo", () => {
    // Given / When / Then
    expect(lexicalOverlap("How is it?", section)).toBe(1);
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

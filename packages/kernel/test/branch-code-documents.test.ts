import { gzipSync } from "node:zlib";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@cerebrium/contracts/code";
import { ConsolidationKind, EdgeType, MemoryKind, Posture } from "@cerebrium/contracts/vocab";
import { CODE_PARSER_TOKEN } from "@/domain/ports/code-parser";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import {
  APPLY_CANDIDATE,
  CODE_COMMIT,
  CODE_MANIFEST,
  CODE_UPLOAD,
  START_SESSION,
  WRITE_MEMORY,
} from "@/application/use-cases";
import { ConsolidationWorker } from "@/application/workers";
import { InProcessCodeParser } from "@/code/unit-parser";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { ConsolidationPostureConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup } from "@test/helpers";
import { TEST_BACKEND } from "@test/pg";

const REMOTE = "github.com/acme/widgets";

const UTIL = `export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}
`;

let session: string;

async function rows<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  return (await container.resolve<PgDatabase>(PG_TOKEN).query(sql, params)).rows as T[];
}

async function index(files: Record<string, string>): Promise<void> {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    content,
    hash: sha256Hex(content),
  }));
  const { missing } = await container
    .resolve(CODE_MANIFEST)
    .invoke({ session_id: session, hashes: entries.map((e) => e.hash) });
  const wanted = new Set(missing);

  await container.resolve(CODE_UPLOAD).invoke({
    session_id: session,
    blobs: entries
      .filter((e) => wanted.has(e.hash))
      .map((e) => ({ hash: e.hash, content: gzipSync(e.content).toString("base64") })),
  });
  await container.resolve(CODE_COMMIT).invoke({
    session_id: session,
    remote_key: REMOTE,
    default_branch: "main",
    branch: "main",
    commit: "main-sha",
    files: entries.map((e) => ({ path: e.path, hash: e.hash })),
  });
}

async function note(content: string, project = "widgets"): Promise<string> {
  const written = await container.resolve(WRITE_MEMORY).invoke({
    session_id: session,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: `Note about ${content.slice(0, 20)}`,
    content,
    project,
    parent_node_id: null,
  });

  return written.envelope.id;
}

function withDocumentsPosture(posture: Posture): void {
  container.register(ConsolidationPostureConfig, {
    useValue: new ConsolidationPostureConfig(
      new StaticConfigSource({ MEMORY_CONSOLIDATE_DOCUMENTS: posture }),
    ),
  });
}

function refs() {
  return rows<{ src: string; type: string; remote_key: string; path: string; qualified: string }>(
    "SELECT src, type, remote_key, path, qualified FROM code_refs WHERE invalidated_at IS NULL",
  );
}

async function hashTokenQualified(): Promise<string> {
  return (
    await rows<{ qualified: string }>("SELECT qualified FROM code_symbols WHERE name = 'hashToken'")
  )[0]!.qualified;
}

describe.skipIf(TEST_BACKEND !== "postgres")(
  "Note-to-code citations on the per-branch index",
  () => {
    beforeEach(async () => {
      setup();
      container.register(CODE_PARSER_TOKEN, { useValue: new InProcessCodeParser() });
      session = (
        await container
          .resolve(START_SESSION)
          .invoke({ project: "widgets", client: { client: "t", version: "1" } })
      ).session_id;
      await index({ "src/util.ts": UTIL });
    });

    afterEach(() => {
      container.register(ConsolidationPostureConfig, {
        useValue: new ConsolidationPostureConfig(new StaticConfigSource({})),
      });
    });

    it("should record the symbol a note cites as a code ref, once", async () => {
      // Given
      const id = await note("the token check goes through `hashToken` before anything else");

      // When
      const first = await container.resolve(ConsolidationWorker).tick();
      await note("an unrelated change");
      const second = await container.resolve(ConsolidationWorker).tick();

      // Then
      expect(first.documents_linked).toBe(1);
      expect(second.documents_linked).toBe(0);
      expect(await refs()).toEqual([
        {
          src: id,
          type: EdgeType.DOCUMENTS,
          remote_key: REMOTE,
          path: "src/util.ts",
          qualified: await hashTokenQualified(),
        },
      ]);
    });

    it("should propose the citation, and record it as a code ref when applied", async () => {
      // Given
      withDocumentsPosture(Posture.SUGGEST);
      const id = await note("the token check goes through `hashToken`");
      const result = await container.resolve(ConsolidationWorker).tick();
      const [candidate] = await rows<{ id: string; kind: string }>(
        "SELECT id, kind FROM consolidation_candidates WHERE status = 'pending'",
      );

      // When
      const applied = await container.resolve(APPLY_CANDIDATE).invoke({
        session_id: session,
        id: candidate!.id,
        decision: ConsolidationRecommendation.APPLY,
      });

      // Then
      expect(result.documents_suggested).toBe(1);
      expect(candidate!.kind).toBe(ConsolidationKind.DOCUMENTS);
      expect(applied.status).toBe("applied");
      expect(await refs()).toEqual([expect.objectContaining({ src: id, path: "src/util.ts" })]);
    });

    it("should not cross from one project's note into another project's code", async () => {
      // Given
      await note("the token check goes through `hashToken`", "some-other-project");

      // When
      const result = await container.resolve(ConsolidationWorker).tick();

      // Then
      expect(result.documents_linked).toBe(0);
      expect(await refs()).toEqual([]);
    });

    it("should rescan once a branch is indexed, without a new revision", async () => {
      // Given
      const id = await note("the parser calls `reverseWords` on every token");
      const worker = container.resolve(ConsolidationWorker);
      const before = await worker.tick();

      // When
      await index({
        "src/util.ts": UTIL,
        "src/words.ts": "export function reverseWords(s: string): string {\n  return s;\n}\n",
      });
      const after = await worker.tick();

      // Then
      expect(before.documents_linked).toBe(0);
      expect(after.documents_linked).toBe(1);
      expect(await refs()).toEqual([expect.objectContaining({ src: id, path: "src/words.ts" })]);
    });
  },
);

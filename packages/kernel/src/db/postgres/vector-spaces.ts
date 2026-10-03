import { injectable } from "tsyringe";
import type { VectorSpace, VectorSpacesRepo } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import { toVectorLiteral } from "@/db/postgres/internal";

@injectable()
export class PgVectorSpacesRepo extends PgBaseRepo implements VectorSpacesRepo {
  async spaces(): Promise<VectorSpace[]> {
    return this.all("SELECT id, model, dim, active, created_at FROM vector_spaces ORDER BY id");
  }

  async ensureSpace(model: string, dim: number, ts: string): Promise<VectorSpace> {
    return this.tx(async () => {
      const existing = await this.one<VectorSpace>(
        "SELECT id, model, dim, active, created_at FROM vector_spaces WHERE model = @model",
        { model },
      );

      if (existing) {
        if (existing.dim !== dim) {
          throw new Error(
            `space ${String(existing.id)} holds ${model} at ${String(existing.dim)}-d, not ${String(dim)}`,
          );
        }

        return existing;
      }

      return (await this.one<VectorSpace>(
        `INSERT INTO vector_spaces (id, model, dim, created_at, active)
         VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM vector_spaces), @model, @dim, @ts, FALSE)
         RETURNING id, model, dim, active, created_at`,
        { model, dim, ts },
      ))!;
    });
  }

  async unembeddedChunks(space: number, limit: number): Promise<{ id: string; text: string }[]> {
    return this.all(
      `SELECT c.id AS id, c.text AS text FROM chunks c
       WHERE c.stale = 0
         AND NOT EXISTS (
           SELECT 1 FROM chunk_vectors v WHERE v.space_id = @space AND v.chunk_id = c.id
         )
       ORDER BY c.id LIMIT @limit`,
      { space, limit },
    );
  }

  async putChunkVectors(
    space: number,
    rows: { chunkId: string; vector: number[] }[],
    modelVersion: string,
    ts: string,
  ): Promise<void> {
    if (!rows.length) return;

    await this.tx(async () => {
      const target = await this.one<{ dim: number }>(
        "SELECT dim FROM vector_spaces WHERE id = @space",
        { space },
      );

      if (!target) throw new Error(`no vector space ${String(space)}`);

      for (const row of rows) {
        if (row.vector.length !== target.dim) {
          throw new Error(
            `a ${String(row.vector.length)}-d vector does not fit the ${String(target.dim)}-d space ${String(space)}`,
          );
        }

        await this.run(
          `INSERT INTO chunk_vectors (space_id, chunk_id, embedding, model_version, ts)
           VALUES (@space, @chunkId, @embedding::vector, @modelVersion, @ts)
           ON CONFLICT (space_id, chunk_id) DO UPDATE SET
             embedding = excluded.embedding, model_version = excluded.model_version, ts = excluded.ts`,
          { space, chunkId: row.chunkId, embedding: toVectorLiteral(row.vector), modelVersion, ts },
        );
      }
    });
  }

  async coverage(space: number): Promise<{ chunks: number; embedded: number }> {
    return (await this.one<{ chunks: number; embedded: number }>(
      `SELECT COUNT(*)::int AS chunks,
              COUNT(v.chunk_id)::int AS embedded
       FROM chunks c
       LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.space_id = @space
       WHERE c.stale = 0`,
      { space },
    ))!;
  }

  async activate(space: number): Promise<void> {
    await this.tx(async () => {
      if (!(await this.one("SELECT id FROM vector_spaces WHERE id = @space", { space }))) {
        throw new Error(`no vector space ${String(space)}`);
      }

      await this.run("UPDATE vector_spaces SET active = FALSE WHERE active AND id <> @space", {
        space,
      });
      await this.run("UPDATE vector_spaces SET active = TRUE WHERE id = @space", { space });
    });
  }
}

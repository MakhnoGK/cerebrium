import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { EmbeddingService } from "@/application/services";
import {
  READ_MIRROR_STATUS,
  REGISTER_SOURCE,
  UPSERT_MIRRORS,
  useCase,
  type MirrorStatusArgs,
  type MirrorStatusResult,
  type ReadMirrorStatus,
  type RegisterSource,
  type RegisterSourceArgs,
  type RegisterSourceResult,
  type UpsertMirrors,
  type UpsertMirrorsArgs,
  type UpsertMirrorsResult,
} from "@/application/use-cases/contracts";
import { MirrorRepo } from "@/db/repositories";

@useCase(REGISTER_SOURCE)
export class LocalRegisterSource implements RegisterSource {
  constructor(
    private readonly mirror: MirrorRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  invoke(args: RegisterSourceArgs): Promise<RegisterSourceResult> {
    return Promise.resolve({
      source: this.mirror.registerSource({
        id: args.id,
        kind: args.kind,
        label: args.label ?? null,
        project: args.project ?? null,
        freshness_hours: args.freshness_hours ?? null,
        recipe: args.recipe ?? null,
        enabled: args.enabled,
        ts: this.clock.now(),
      }),
    });
  }
}

@useCase(UPSERT_MIRRORS)
export class LocalUpsertMirrors implements UpsertMirrors {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly mirror: MirrorRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  invoke(args: UpsertMirrorsArgs): Promise<UpsertMirrorsResult> {
    const source = this.mirror.getSource(args.source_id);

    if (!source) {
      throw new Error(
        `source '${args.source_id}' is not registered. Register it first with \`source_register\`.`,
      );
    }

    if (!source.enabled) {
      throw new Error(
        `source '${args.source_id}' is disabled. Re-enable it with \`source_register\` (enabled:true) before mirroring.`,
      );
    }

    return Promise.resolve({
      result: this.mirror.upsertMirrors(source, args.items, args.session_id, this.clock.now()),
      notes: this.embeddings.getEmbeddingNotes(),
    });
  }
}

@useCase(READ_MIRROR_STATUS)
export class LocalReadMirrorStatus implements ReadMirrorStatus {
  constructor(
    private readonly mirror: MirrorRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  invoke(args: MirrorStatusArgs): Promise<MirrorStatusResult> {
    return Promise.resolve({
      sources: this.mirror.sourceStatus(this.clock.now(), args.source_id),
    });
  }
}

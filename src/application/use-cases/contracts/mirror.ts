import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type {
  MirrorItem,
  MirrorSource,
  MirrorSourceStatus,
  MirrorUpsertResult,
} from "@/core/types";

export interface RegisterSourceArgs {
  id: string;
  kind: string;
  label?: string;
  project?: string;
  freshness_hours?: number;
  recipe?: string;
  enabled?: boolean;
}

export interface RegisterSourceResult {
  source: MirrorSource;
}

export type RegisterSource = UseCase<RegisterSourceArgs, RegisterSourceResult>;

export const REGISTER_SOURCE = useCaseToken<RegisterSourceArgs, RegisterSourceResult>(
  "RegisterSource",
);

export interface UpsertMirrorsArgs {
  session_id: string;
  source_id: string;
  items: MirrorItem[];
}

export interface UpsertMirrorsResult {
  result: MirrorUpsertResult;
  notes: string[];
}

export type UpsertMirrors = UseCase<UpsertMirrorsArgs, UpsertMirrorsResult>;

export const UPSERT_MIRRORS = useCaseToken<UpsertMirrorsArgs, UpsertMirrorsResult>("UpsertMirrors");

export interface MirrorStatusArgs {
  source_id?: string;
}

export interface MirrorStatusResult {
  sources: MirrorSourceStatus[];
}

export type ReadMirrorStatus = UseCase<MirrorStatusArgs, MirrorStatusResult>;

export const READ_MIRROR_STATUS = useCaseToken<MirrorStatusArgs, MirrorStatusResult>(
  "ReadMirrorStatus",
);

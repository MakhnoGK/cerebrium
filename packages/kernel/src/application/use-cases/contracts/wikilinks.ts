import type {
  WikilinkDangler,
  WikilinkFix,
  WikilinkFixResult,
} from "@cerebrium/contracts/wikilinks";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

export interface ListDanglersArgs {
  session_id?: string;
  limit?: number;
}

export type ListDanglers = UseCase<ListDanglersArgs, WikilinkDangler[]>;

export const LIST_DANGLERS = useCaseToken<ListDanglersArgs, WikilinkDangler[]>("ListDanglers");

export interface FixWikilinkArgs extends WikilinkFix {
  session_id: string;
}

export type FixWikilink = UseCase<FixWikilinkArgs, WikilinkFixResult>;

export const FIX_WIKILINK = useCaseToken<FixWikilinkArgs, WikilinkFixResult>("FixWikilink");

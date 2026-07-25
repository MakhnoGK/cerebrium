import { AbstractTool } from "./contracts";
import { SearchTool } from "./search";
import { SessionStartTool } from "./session_start";
import { GetTool } from "./get";
import { WriteTool } from "./write";
import { UpdateTool } from "./update";
import { InvalidateTool } from "./invalidate";
import { CheckpointTool } from "./checkpoint";
import { LinkTool } from "./link";
import { CodeIndexTool } from "./code_index";
import { CodeLookupTool } from "./code_lookup";
import { SourceRegisterTool } from "./source_register";
import { MirrorUpsertTool } from "./mirror_upsert";
import { MirrorStatusTool } from "./mirror_status";
import { ConsolidateSuggestTool } from "./consolidate_suggest";
import { ConsolidateApplyTool } from "./consolidate_apply";
import { StatsTool } from "./stats";

export const TOOLS: AbstractTool[] = [
  new SessionStartTool(),
  new SearchTool(),
  new GetTool(),
  new WriteTool(),
  new UpdateTool(),
  new InvalidateTool(),
  new CheckpointTool(),
  new LinkTool(),
  new CodeIndexTool(),
  new CodeLookupTool(),
  new SourceRegisterTool(),
  new MirrorUpsertTool(),
  new MirrorStatusTool(),
  new ConsolidateSuggestTool(),
  new ConsolidateApplyTool(),
  new StatsTool(),
];

import { EventAction } from "@/core/vocab";
import { ToolName } from "@/presentation/mcp/tools/contracts";

const TOOL_ACTIONS: Record<ToolName, EventAction> = {
  [ToolName.SESSION_START]: EventAction.SESSION_START,
  [ToolName.SEARCH]: EventAction.SEARCH,
  [ToolName.GET]: EventAction.GET,
  [ToolName.WRITE]: EventAction.WRITE,
  [ToolName.UPDATE]: EventAction.UPDATE,
  [ToolName.INVALIDATE]: EventAction.INVALIDATE,
  [ToolName.RESTORE]: EventAction.RESTORE,
  [ToolName.CHECKPOINT]: EventAction.CHECKPOINT,
  [ToolName.LINK]: EventAction.LINK,
  [ToolName.CODE_INDEX]: EventAction.CODE_INDEX,
  [ToolName.CODE_LOOKUP]: EventAction.CODE_LOOKUP,
  [ToolName.SOURCE_REGISTER]: EventAction.SOURCE_REGISTER,
  [ToolName.MIRROR_UPSERT]: EventAction.MIRROR_UPSERT,
  [ToolName.MIRROR_STATUS]: EventAction.MIRROR_STATUS,
  [ToolName.CONSOLIDATE_SUGGEST]: EventAction.CONSOLIDATE_SUGGEST,
  [ToolName.CONSOLIDATE_APPLY]: EventAction.CONSOLIDATE_APPLY,
  [ToolName.STATS]: EventAction.STATS,
};

export function actionForTool(name: ToolName): EventAction {
  return TOOL_ACTIONS[name];
}

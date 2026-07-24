// Public entry for the MCP tool modules — each exposes { schema, description,
// handler }. The server registers from here. Tools import their shared helpers
// (context, notes) by direct path, never through this barrel, to avoid cycles.
export * as session_start from "@/tools/session_start";
export * as search from "@/tools/search";
export * as get from "@/tools/get";
export * as write from "@/tools/write";
export * as update from "@/tools/update";
export * as invalidate from "@/tools/invalidate";
export * as checkpoint from "@/tools/checkpoint";
export * as link from "@/tools/link";
export * as code_index from "@/tools/code_index";
export * as code_lookup from "@/tools/code_lookup";
export * as source_register from "@/tools/source_register";
export * as mirror_upsert from "@/tools/mirror_upsert";
export * as mirror_status from "@/tools/mirror_status";
export * as consolidate_suggest from "@/tools/consolidate_suggest";
export * as consolidate_apply from "@/tools/consolidate_apply";
export * as stats from "@/tools/stats";

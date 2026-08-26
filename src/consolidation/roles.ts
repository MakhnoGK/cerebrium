import { GENERATION_ROLES, GenerationRole } from "@/core/vocab";

// What one role may say about itself. A role names a model, a host and a deadline — never
// a backend kind: `enabled` is a property of the kind (a `manual` provider generates
// nothing at all), and the per-behaviour switch is already `consolidation.posture.*`.
export interface RoleOverride {
  url?: string;
  model?: string;
  timeoutMs?: number;
}

export type RoleOverrides = Partial<Record<GenerationRole, RoleOverride>>;

// The flat settings every role inherits when it says nothing.
export interface RoleBase {
  url: string;
  model: string;
  timeoutMs: number;
  reconcileTimeoutMs: number;
}

// One role, resolved: exactly what a call for it will be sent with. `timeoutKnob` is the
// config path that supplied the deadline, so a timeout error names the knob to raise
// rather than the one that happens to be nearest.
export interface RoleBackend {
  role: GenerationRole;
  url: string;
  model: string;
  timeoutMs: number;
  timeoutKnob: string;
  // Which fields this role set for itself. Empty means it inherits everything.
  overrides: readonly (keyof RoleOverride)[];
}

export type ResolvedRoles = Record<GenerationRole, RoleBackend>;

const BASE_TIMEOUT_KNOB: Record<GenerationRole, string> = {
  [GenerationRole.GENERATE]: "MEMORY_CONSOLIDATE_TIMEOUT_MS",
  [GenerationRole.ANNOTATE]: "MEMORY_CONSOLIDATE_TIMEOUT_MS",
  [GenerationRole.RECONCILE]: "MEMORY_CONSOLIDATE_RECONCILE_TIMEOUT_MS",
};

// Resolve every role against the flat settings. Unset overrides inherit, so a deployment
// that names no role behaves exactly as one model with the two deadlines it had before.
export function resolveRoles(base: RoleBase, overrides: RoleOverrides = {}): ResolvedRoles {
  const resolved = {} as ResolvedRoles;

  for (const role of GENERATION_ROLES) {
    const override = overrides[role] ?? {};
    const inheritedMs =
      role === GenerationRole.RECONCILE ? base.reconcileTimeoutMs : base.timeoutMs;

    resolved[role] = {
      role,
      url: override.url ?? base.url,
      model: override.model ?? base.model,
      timeoutMs: override.timeoutMs ?? inheritedMs,
      timeoutKnob:
        override.timeoutMs === undefined
          ? BASE_TIMEOUT_KNOB[role]
          : `consolidation.roles.${role}.timeoutMs`,
      overrides: (["url", "model", "timeoutMs"] as const).filter(
        (key) => override[key] !== undefined,
      ),
    };
  }

  return resolved;
}

// The role table as an operator reads it: what each role will run, and whether it says so
// itself or inherits. Reported by `stats`, so pointing a role at another model is visible
// before any call is made.
export function describeRoles(roles: ResolvedRoles): Record<string, unknown> {
  const described: Record<string, unknown> = {};

  for (const role of GENERATION_ROLES) {
    const backend = roles[role];

    described[role] = {
      model: backend.model,
      url: backend.url,
      timeout_ms: backend.timeoutMs,
      inherited: backend.overrides.length === 0,
    };
  }

  return described;
}

// Parse the `consolidation.roles` map. One malformed entry falls the whole field back to
// "no overrides" and is reported through provenance, rather than half-applying a table
// whose remaining half silently means something else.
export function parseRoleOverrides(raw: string): RoleOverrides | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const overrides: RoleOverrides = {};

  for (const [name, value] of Object.entries(parsed)) {
    if (!isRole(name)) return undefined;

    const override = coerceOverride(value);

    if (override === undefined) return undefined;

    overrides[name] = override;
  }

  return overrides;
}

function coerceOverride(value: unknown): RoleOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const override: RoleOverride = {};

  for (const [key, setting] of Object.entries(value)) {
    if (key === "url" || key === "model") {
      if (typeof setting !== "string" || !setting.trim().length) return undefined;

      override[key] = setting;
      continue;
    }

    if (key !== "timeoutMs") return undefined;
    if (typeof setting !== "number" || !Number.isInteger(setting) || setting <= 0) return undefined;

    override.timeoutMs = setting;
  }

  return override;
}

function isRole(name: string): name is GenerationRole {
  return (GENERATION_ROLES as readonly string[]).includes(name);
}

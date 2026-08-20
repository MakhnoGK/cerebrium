import { configSection, custom, SectionOf } from "@/domain/ports/config";
import { Capability, Posture } from "@/core/vocab";

// What one principal is allowed to do. Absent capabilities fall back to the default
// profile, so a config naming one principal does not have to restate the rest.
export interface PrincipalProfile {
  capabilities: Partial<Record<Capability, Posture>>;
}

export const OPEN_PROFILE: PrincipalProfile = { capabilities: {} };

// Per-principal policy, keyed by the client name the MCP handshake reports. It lives in
// config rather than in the store on purpose: the call surface is what principals reach,
// and a principal able to write its own profile could grant itself anything.
//
// `MEMORY_PRINCIPALS` carries the same JSON for a deployment with no config file.
@configSection()
export class PrincipalsConfig extends SectionOf("principals", {
  profiles: custom<Record<string, PrincipalProfile>>({}, parseProfiles).env("MEMORY_PRINCIPALS"),
  default: custom<PrincipalProfile>(OPEN_PROFILE, parseProfile).env("MEMORY_PRINCIPAL_DEFAULT"),
}) {}

function parseProfiles(raw: string): Record<string, PrincipalProfile> | undefined {
  const parsed = json(raw);

  if (parsed === undefined) return undefined;

  const profiles: Record<string, PrincipalProfile> = {};

  for (const [id, value] of Object.entries(parsed)) {
    const profile = coerce(value);

    // One malformed entry must not silently widen the others into defaults; the whole
    // field falls back and the provenance record reports it.
    if (profile === undefined) return undefined;

    profiles[id] = profile;
  }

  return profiles;
}

function parseProfile(raw: string): PrincipalProfile | undefined {
  const parsed = json(raw);

  return parsed === undefined ? undefined : coerce(parsed);
}

function json(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function coerce(value: unknown): PrincipalProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const raw = (value as { capabilities?: unknown }).capabilities;

  if (raw === undefined) return { capabilities: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const capabilities: Partial<Record<Capability, Posture>> = {};

  for (const [name, posture] of Object.entries(raw)) {
    if (!isCapability(name) || !isPosture(posture)) return undefined;

    capabilities[name] = posture;
  }

  return { capabilities };
}

function isCapability(name: string): name is Capability {
  return (Object.values(Capability) as string[]).includes(name);
}

function isPosture(value: unknown): value is Posture {
  return typeof value === "string" && (Object.values(Posture) as string[]).includes(value);
}

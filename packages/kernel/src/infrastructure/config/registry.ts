import { injectable, injectAll } from "tsyringe";
import { CONFIG_SECTION_TOKEN, sectionMeta, type FieldProvenance } from "@/domain/ports/config";

export interface EffectiveConfig {
  values: Record<string, Record<string, unknown>>;
  provenance: FieldProvenance[];
}

// Every registered section, aggregated. This is what makes a process's resolved config
// observable rather than guessable — the gap that made the daemon's effective posture
// depend on whichever process happened to spawn it first.
@injectable()
export class ConfigRegistry {
  constructor(@injectAll(CONFIG_SECTION_TOKEN) private readonly sections: object[]) {}

  effective(): EffectiveConfig {
    const values: Record<string, Record<string, unknown>> = {};
    const provenance: FieldProvenance[] = [];

    for (const section of this.sections) {
      const meta = sectionMeta(section);

      values[meta.path] = { ...section };
      provenance.push(...meta.provenance);
    }

    return { values, provenance };
  }

  // Env vars that were set but unusable. Empty in a healthy deployment; anything here is
  // a typo silently falling back to a default.
  ignored(): FieldProvenance[] {
    return this.effective().provenance.filter((entry) => entry.ignored !== undefined);
  }
}

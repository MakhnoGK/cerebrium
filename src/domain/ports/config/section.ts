import { container, type InjectionToken } from "tsyringe";
import type { Field } from "@/domain/ports/config/field";
import { CONFIG_SOURCE_TOKEN } from "@/domain/ports/config/source";
import type { ConfigSource, FieldProvenance } from "@/domain/ports/config/source";

// `Field<unknown>` rather than `Field<never>`: the type parameter appears in output
// positions, so a concrete field widens to it. `Infer` narrows each entry back.
export type SectionSpec = Record<string, Field<unknown>>;

type Infer<S extends SectionSpec> = {
  readonly [K in keyof S]: S[K] extends Field<infer T> ? T : never;
};

export const CONFIG_SECTION_TOKEN: InjectionToken<object> = Symbol("ConfigSection");

// Provenance is kept off the instance so a section serializes to exactly its values.
const META = new WeakMap<object, { path: string; provenance: FieldProvenance[] }>();

export function sectionMeta(instance: object): { path: string; provenance: FieldProvenance[] } {
  return META.get(instance) ?? { path: "?", provenance: [] };
}

export class ConfigError extends Error {}

// Build a base class whose instances carry one readonly property per spec entry, typed
// from the spec. A section is then `class X extends SectionOf("path", { … }) {}`.
export function SectionOf<S extends SectionSpec>(
  path: string,
  spec: S,
): new (source: ConfigSource) => Infer<S> {
  // A constructor-only class is the point here: the shape comes from `spec`, so there is
  // nothing to declare as a member.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class Section {
    constructor(source: ConfigSource) {
      const provenance: FieldProvenance[] = [];
      const values: Record<string, unknown> = {};

      for (const [key, field] of Object.entries(spec)) {
        const fieldPath = `${path}.${key}`;
        const envName = field.envName(fieldPath);
        const hit = source.read(fieldPath, envName);
        const raw = hit?.raw;
        const coerced = raw === undefined ? undefined : field.coerce(raw);

        if (coerced === undefined) {
          values[key] = field.fallback;
          provenance.push({
            path: fieldPath,
            envName,
            source: "default",
            // A set-but-unusable value is a typo, not a reason to refuse to start —
            // but it is recorded so it can be surfaced instead of silently swallowed.
            ...(raw?.trim().length ? { ignored: { raw, reason: "could not be parsed" } } : {}),
          });
          continue;
        }

        const invalid = field.validate(coerced);

        if (invalid) {
          throw new ConfigError(`${envName} (${fieldPath}) ${invalid}, got '${raw ?? ""}'.`);
        }

        values[key] = coerced;
        provenance.push({ path: fieldPath, envName, source: hit!.origin });
      }

      Object.assign(this, values);
      Object.freeze(this);
      META.set(this, { path, provenance });
    }
  }

  return Section as unknown as new (source: ConfigSource) => Infer<S>;
}

// Registers a section under its own class (so consumers inject it by type) and under the
// shared token (so ConfigRegistry can enumerate every section).
//
// The factory constructs explicitly rather than letting tsyringe resolve constructor
// params: a section subclass declares no constructor, so `design:paramtypes` metadata is
// never emitted for it and param injection would silently pass undefined.
export function configSection(): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as new (source: ConfigSource) => object;

    container.register(target as never, {
      useFactory: (dependencyContainer) =>
        new ctor(dependencyContainer.resolve<ConfigSource>(CONFIG_SOURCE_TOKEN)),
    });
    container.register(CONFIG_SECTION_TOKEN, {
      useFactory: (dependencyContainer) => dependencyContainer.resolve(target as never),
    });
  };
}

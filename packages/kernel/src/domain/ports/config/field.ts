// Declarative config fields. One `Field` carries everything a property needs — its
// fallback, how to read it from a raw string, how to validate it, and (optionally) a
// legacy env-var name. Adding a config property is a single line in a section spec.
//
// Two failure modes, deliberately different:
//   - unparseable (`sim=abc`)     -> `coerce` returns undefined; the fallback applies and
//                                    the source records it. A typo must not stop startup.
//   - out of range (`sim=1.5`)    -> `validate` returns a message; the caller throws.
//                                    A meaningfully wrong value must not be silently hidden.

export abstract class Field<T> {
  private explicitEnv?: string;

  constructor(readonly fallback: T) {}

  // Pin a legacy env-var name. Without this the name is derived from the config path,
  // so a new property needs no env bookkeeping at all.
  env(name: string): this {
    this.explicitEnv = name;
    return this;
  }

  envName(path: string): string {
    return this.explicitEnv ?? derivedEnvName(path);
  }

  abstract coerce(raw: string): T | undefined;

  validate(_value: T): string | null {
    return null;
  }
}

// `retrieval.symbolWeight` -> `MEMORY_RETRIEVAL_SYMBOL_WEIGHT`
export function derivedEnvName(path: string): string {
  const snake = path
    .replace(/\./g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();

  return `MEMORY_${snake}`;
}

class NumberField extends Field<number> {
  private lo = -Infinity;
  private hi = Infinity;
  private integer = false;

  range(lo: number, hi: number): this {
    this.lo = lo;
    this.hi = hi;
    return this;
  }

  positive(): this {
    this.lo = Number.MIN_VALUE;
    return this;
  }

  nonNegative(): this {
    this.lo = 0;
    return this;
  }

  min(lo: number): this {
    this.lo = lo;
    return this;
  }

  int(): this {
    this.integer = true;
    return this;
  }

  coerce(raw: string): number | undefined {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);

    return trimmed.length && Number.isFinite(parsed) ? parsed : undefined;
  }

  validate(value: number): string | null {
    if (this.integer && !Number.isInteger(value)) return "must be an integer";
    if (value < this.lo)
      return `must be >= ${this.lo === Number.MIN_VALUE ? "0 (exclusive)" : String(this.lo)}`;
    if (value > this.hi) return `must be <= ${String(this.hi)}`;

    return null;
  }
}

class StringField extends Field<string> {
  private allowEmpty = false;

  emptyAllowed(): this {
    this.allowEmpty = true;
    return this;
  }

  coerce(raw: string): string | undefined {
    // A blank env var reads as unset, matching the `env || "default"` idiom this replaces.
    return this.allowEmpty || raw.trim().length ? raw : undefined;
  }
}

class NullableStringField extends Field<string | null> {
  coerce(raw: string): string | null | undefined {
    return raw.trim().length ? raw : undefined;
  }
}

class EnumField<E extends Record<string, string>> extends Field<E[keyof E]> {
  constructor(
    private readonly values: E,
    fallback: E[keyof E],
  ) {
    super(fallback);
  }

  coerce(raw: string): E[keyof E] | undefined {
    const needle = raw.trim().toLowerCase();
    const hit = Object.values(this.values).find((v) => v.toLowerCase() === needle);

    return hit as E[keyof E] | undefined;
  }
}

class BooleanField extends Field<boolean> {
  // Accepts the spellings a plist, a shell export and a JSON config all produce. Anything
  // else is unparseable rather than falsy: `MEMORY_DAEMON_RESIDENT=maybe` must fall back
  // and be reported, not silently mean "off".
  coerce(raw: string): boolean | undefined {
    const v = raw.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;

    return undefined;
  }
}

class CustomField<T> extends Field<T> {
  constructor(
    fallback: T,
    private readonly parse: (raw: string) => T | undefined,
  ) {
    super(fallback);
  }

  coerce(raw: string): T | undefined {
    return this.parse(raw);
  }
}

export const num = (fallback: number): NumberField => new NumberField(fallback);
export const int = (fallback: number): NumberField => new NumberField(fallback).int();
export const str = (fallback: string): StringField => new StringField(fallback);
export const bool = (fallback: boolean): BooleanField => new BooleanField(fallback);
export const nullableStr = (fallback: string | null): NullableStringField =>
  new NullableStringField(fallback);
export const enumOf = <E extends Record<string, string>>(
  values: E,
  fallback: E[keyof E],
): EnumField<E> => new EnumField(values, fallback);
export const custom = <T>(fallback: T, parse: (raw: string) => T | undefined): CustomField<T> =>
  new CustomField(fallback, parse);

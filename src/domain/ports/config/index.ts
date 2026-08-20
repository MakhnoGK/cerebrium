// Public entry for the config mechanism. Sections import the builders by direct path.
export {
  custom,
  derivedEnvName,
  enumOf,
  Field,
  int,
  nullableStr,
  num,
  str,
} from "@/domain/ports/config/field";
export {
  CONFIG_SECTION_TOKEN,
  ConfigError,
  configSection,
  SectionOf,
  sectionMeta,
  type SectionSpec,
} from "@/domain/ports/config/section";
export {
  CONFIG_SOURCE_TOKEN,
  type ConfigOrigin,
  type ConfigSource,
  type ConfigValue,
  type FieldProvenance,
} from "@/domain/ports/config/source";

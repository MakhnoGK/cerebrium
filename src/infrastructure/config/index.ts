// Public entry for the config infrastructure. Members import each other by direct path.
export {
  DefaultConfigSource,
  EnvConfigSource,
  LayeredConfigSource,
  StaticConfigSource,
} from "@/infrastructure/config/env-source";
export { ConfigRegistry, type EffectiveConfig } from "@/infrastructure/config/registry";
export * from "@/infrastructure/config/sections";

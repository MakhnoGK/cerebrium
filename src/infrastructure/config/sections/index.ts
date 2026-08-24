// Side-effect imports run the @configSection() decorators, which register each section
// under its own class and under CONFIG_SECTION_TOKEN. Composition roots import this once.
import "@/infrastructure/config/sections/consolidation.config";
import "@/infrastructure/config/sections/jobs.config";
import "@/infrastructure/config/sections/principals.config";
import "@/infrastructure/config/sections/runtime.config";

export {
  ConsolidationBatchConfig,
  ConsolidationConfig,
  ConsolidationPostureConfig,
  ConsolidationThresholdsConfig,
} from "@/infrastructure/config/sections/consolidation.config";
export { JobsConfig } from "@/infrastructure/config/sections/jobs.config";
export {
  type CodeRoot,
  CodeConfig,
  DaemonConfig,
  DatabaseConfig,
  EmbeddingConfig,
  RetrievalConfig,
} from "@/infrastructure/config/sections/runtime.config";
export {
  NEUTRAL_WEIGHT,
  OPEN_PROFILE,
  PrincipalsConfig,
  type PrincipalProfile,
  type PrincipalQuota,
} from "@/infrastructure/config/sections/principals.config";

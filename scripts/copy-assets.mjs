import { cpSync, existsSync, mkdirSync } from "node:fs";

// The bundled bins live at the dist root (tsup splitting:false), so database.ts
// resolves migrations relative to dist/ via import.meta.url. Copy them there.
mkdirSync("dist", { recursive: true });
if (existsSync("packages/kernel/src/db/sqlite/migrations")) {
  cpSync("packages/kernel/src/db/sqlite/migrations", "dist/migrations", { recursive: true });
}
if (existsSync("packages/kernel/src/code/vendor")) {
  cpSync("packages/kernel/src/code/vendor", "dist/vendor", { recursive: true });
}

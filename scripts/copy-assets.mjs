import { cpSync, existsSync, mkdirSync } from "node:fs";

// The bundled bins live at the dist root (tsup splitting:false), so database.ts
// resolves migrations relative to dist/ via import.meta.url. Copy them there.
mkdirSync("dist", { recursive: true });
if (existsSync("src/db/migrations")) {
  cpSync("src/db/migrations", "dist/migrations", { recursive: true });
}

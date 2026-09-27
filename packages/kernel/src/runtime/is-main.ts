import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// True when `moduleUrl` (pass `import.meta.url`) is the process entrypoint.
// A bare `process.argv[1] === fileURLToPath(import.meta.url)` check breaks when
// the entry is a `bin` symlink (npm link / global install): argv[1] is the
// symlink path while the ESM loader resolves import.meta.url to the real file.
// Resolve argv[1] through realpath before comparing.
export function isMainModule(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const target = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === target;
  } catch {
    return argv1 === target;
  }
}

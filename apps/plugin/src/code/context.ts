import type { CodeContext } from "@cerebrium/contracts/code";
import { readCheckout } from "@plugin/src/code/git";

const TTL_MS = 3_000;

// The repo and branch of the directory this process runs in, re-read at most every few
// seconds so a `git checkout` mid-session moves code reads with it.
export function codeContextOf(
  cwd: () => string = () => process.cwd(),
): () => Promise<CodeContext | null> {
  let cached: { at: number; dir: string; value: Promise<CodeContext | null> } | null = null;

  return () => {
    const dir = cwd();
    const now = Date.now();

    if (cached?.dir !== dir || now - cached.at > TTL_MS) {
      cached = {
        at: now,
        dir,
        value: readCheckout(dir, false).then(
          (c) => ({ remote_key: c.remote_key, branch: c.branch }),
          () => null,
        ),
      };
    }

    return cached.value;
  };
}

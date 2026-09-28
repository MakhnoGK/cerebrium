import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { PLUGIN_BUILD } from "@plugin/tsup.config";

export interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { entryPoint?: string; imports: { path: string; external?: boolean }[] }>;
}

export interface PluginBundle {
  dir: string;
  server: string;
  metafile: Metafile;
}

let built: Promise<PluginBundle> | null = null;

// Built once per test file, into a directory with no node_modules above it, so running the
// output proves it needs nothing but node.
export function pluginBundle(): Promise<PluginBundle> {
  built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-plugin-bundle-"));

    await build({ ...PLUGIN_BUILD, outDir: dir, metafile: true, config: false, silent: true });

    return {
      dir,
      server: join(dir, "server.js"),
      metafile: JSON.parse(readFileSync(join(dir, "metafile-esm.json"), "utf8")) as Metafile,
    };
  })();

  return built;
}

export interface Exited {
  code: number | null;
  stderr: string;
}

export function runToExit(server: string, env: Record<string, string>): Promise<Exited> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

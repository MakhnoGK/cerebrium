import { container, type DependencyContainer } from "tsyringe";
import type { CodeContext } from "@cerebrium/contracts/code";
import { CONFIG_FILE_TOKEN, CONFIG_SOURCE_TOKEN, type ConfigSource } from "@/domain/ports/config";
import {
  DaemonConfig,
  EnvConfigSource,
  FileConfigSource,
  KernelConfig,
  LayeredConfigSource,
} from "@/infrastructure/config";
import "@/infrastructure/config/sections";
import { explicitKernel } from "@/runtime/kernel-choice";
import { configFilePath } from "@/runtime/paths";
import { registerRemoteKernel } from "@/runtime/remote-kernel";

// The composition root of a host that holds no kernel of its own. It imports no storage
// backend, provider or local use case, so a bundle built from it carries none of them.

export interface RemoteContainerOptions {
  source?: ConfigSource;
  into?: DependencyContainer;
  // Refuse to fall back to the local daemon's socket when no kernel URL is configured.
  requireUrl?: boolean;
  codeContext?: () => Promise<CodeContext | null>;
}

export class KernelUrlMissingError extends Error {
  constructor() {
    super(
      "MEMORY_KERNEL_URL is not set. This server only talks to a Cerebrium host: set " +
        "MEMORY_KERNEL_URL (tcp://host:port) and MEMORY_KERNEL_TOKEN_FILE.",
    );
    this.name = "KernelUrlMissingError";
  }
}

export function buildRemoteContainer({
  source,
  into,
  requireUrl = false,
  codeContext,
}: RemoteContainerOptions = {}): DependencyContainer {
  const target = into ?? container;

  registerConfigSource(target, source);

  const explicit = explicitKernel(target.resolve(KernelConfig));

  if (explicit === null && requireUrl) throw new KernelUrlMissingError();

  registerRemoteKernel(target, {
    ...(explicit === null
      ? { socketPath: target.resolve(DaemonConfig).socketPath }
      : { socketPath: explicit.url, token: explicit.token }),
    ...(codeContext === undefined ? {} : { codeContext }),
  });

  return target;
}

// Tiers: defaults <- config.json <- environment. Every host resolves them here and only
// here, so spawn order can no longer decide what a process is configured with — the
// daemon's posture used to depend on whether the GUI or Claude Code started it first.
export function registerConfigSource(target: DependencyContainer, pinned?: ConfigSource): void {
  if (pinned) {
    target.register(CONFIG_SOURCE_TOKEN, { useValue: pinned });
    // A factory, not `useValue: null`: tsyringe tests `useValue != undefined`, so a null
    // value provider falls through and it tries to construct the token instead.
    target.register(CONFIG_FILE_TOKEN, { useFactory: () => null });

    return;
  }

  const file = new FileConfigSource(configFilePath());

  target.register(CONFIG_SOURCE_TOKEN, {
    useValue: new LayeredConfigSource(new EnvConfigSource(), file),
  });
  target.register(CONFIG_FILE_TOKEN, { useValue: file.report() });
}

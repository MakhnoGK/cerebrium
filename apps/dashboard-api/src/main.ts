#!/usr/bin/env node
import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";
import { ApiController } from "./api.controller";
import { KernelClient } from "./kernel.client";
import { ReviewController } from "./review.controller";
import { ReviewService } from "./review.service";
import { OLLAMA_URL, StatusService } from "./status.service";

export interface DashboardOptions {
  socketPath: string;
  token: string | null;
  ollamaUrl: string;
}

@Module({})
export class DashboardModule {
  static with(options: DashboardOptions): DynamicModule {
    return {
      module: DashboardModule,
      controllers: [ApiController, ReviewController],
      providers: [
        {
          provide: KernelClient,
          useFactory: () => new KernelClient(options.socketPath, options.token),
        },
        { provide: OLLAMA_URL, useValue: options.ollamaUrl },
        StatusService,
        ReviewService,
      ],
    };
  }
}

// The web build sits next to this bundle in the image, and in the app's own dist in a
// checkout.
function webRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));

  return (
    [join(here, "dashboard-web"), join(here, "..", "apps", "dashboard-web", "dist")].find((dir) =>
      existsSync(join(dir, "index.html")),
    ) ?? null
  );
}

async function main(): Promise<void> {
  const home = process.env.CEREBRIUM_HOME ?? join(process.env.HOME ?? "/tmp", ".cerebrium");
  const tokenFile = process.env.MEMORY_KERNEL_TOKEN_FILE;
  const app = await NestFactory.create<NestExpressApplication>(
    DashboardModule.with({
      socketPath:
        process.env.MEMORY_KERNEL_URL ??
        process.env.MEMORY_DAEMON_SOCKET ??
        join(home, "daemon.sock"),
      token: tokenFile ? readFileSync(tokenFile, "utf8").trim() : null,
      ollamaUrl: process.env.DASHBOARD_OLLAMA_URL ?? "http://host.docker.internal:11434",
    }),
    { logger: ["error", "warn"] },
  );
  const web = webRoot();

  if (web !== null) app.useStaticAssets(web);

  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.DASHBOARD_PORT ?? 7480),
    process.env.DASHBOARD_HOST ?? "0.0.0.0",
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`dashboard failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

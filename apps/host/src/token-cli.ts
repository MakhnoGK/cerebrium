import { writeFileSync } from "node:fs";
import type { DependencyContainer } from "tsyringe";
import { PrincipalTokenService } from "@cerebrium/kernel/application/services";
import { buildContainer } from "@cerebrium/kernel/container";
import { STORE_TOKEN, type Store } from "@cerebrium/kernel/domain/ports/storage";
import { StorageConfig, STORE_BACKENDS } from "@cerebrium/kernel/infrastructure/config";

export const TOKEN_USAGE = `cerebrium-service token <command>

  issue --principal <id> --label <label> [--out <path>]
              mint a token for the network listener. With --out it is written to a new
              0600 file; without, it is the only thing printed to stdout.
  list        every token, revoked ones included; never the token itself
  revoke <id> revoke a token; its row is kept

Postgres only: run it where the host daemon's store is configured.
`;

export interface TokenIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const STDIO: TokenIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  const value = at < 0 ? undefined : argv[at + 1];

  return value === undefined || value.startsWith("--") ? null : value;
}

export async function runTokenCommand(
  argv: string[],
  tokens: PrincipalTokenService,
  io: TokenIo = STDIO,
): Promise<number> {
  switch (argv[0]) {
    case "issue": {
      const principal = flag(argv, "--principal");
      const label = flag(argv, "--label");
      const out = flag(argv, "--out");

      if (principal === null || label === null) {
        io.err(`token issue needs --principal and --label\n\n${TOKEN_USAGE}`);

        return 2;
      }

      const issued = await tokens.issue(principal, label);
      const about = `issued token ${issued.id} for ${issued.principal} (${issued.label})`;

      if (out === null) {
        io.out(`${issued.token}\n`);
        io.err(`${about}\n`);
      } else {
        writeFileSync(out, `${issued.token}\n`, { mode: 0o600, flag: "wx" });
        io.out(`${about} → ${out}\n`);
      }

      return 0;
    }
    case "list": {
      for (const row of await tokens.list()) {
        io.out(
          [
            row.id,
            row.principal_id,
            row.label,
            `created ${row.created_at}`,
            `used ${row.last_used_at ?? "never"}`,
            row.revoked_at === null ? "live" : `revoked ${row.revoked_at}`,
          ].join("  ") + "\n",
        );
      }

      return 0;
    }
    case "revoke": {
      const id = argv[1];

      if (id === undefined) {
        io.err(`token revoke needs an id\n\n${TOKEN_USAGE}`);

        return 2;
      }

      if (!(await tokens.revoke(id))) {
        io.err(`no live token ${id}\n`);

        return 1;
      }

      io.out(`revoked ${id}\n`);

      return 0;
    }
    default:
      io.err(TOKEN_USAGE);

      return argv[0] === undefined || argv[0] === "--help" ? 0 : 2;
  }
}

const COMMANDS = new Set(["issue", "list", "revoke"]);

export async function tokenCli(
  argv: string[],
  io: TokenIo = STDIO,
  build: () => DependencyContainer = () => buildContainer({ role: "server" }),
): Promise<number> {
  if (!COMMANDS.has(argv[0] ?? "")) {
    io.err(TOKEN_USAGE);

    return argv[0] === undefined || argv[0] === "--help" ? 0 : 2;
  }

  const container = build();
  const backend = container.resolve(StorageConfig).backend;

  if (backend !== STORE_BACKENDS.POSTGRES) {
    io.err(`token commands need the postgres store; this one is ${backend}\n`);

    return 1;
  }

  try {
    return await runTokenCommand(argv, container.resolve(PrincipalTokenService), io);
  } finally {
    await container.resolve<Store>(STORE_TOKEN).close();
  }
}

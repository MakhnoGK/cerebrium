export class RepositoryNotConfiguredError extends Error {
  constructor(repo: string) {
    super(
      `repo '${repo}' is not configured (MEMORY_CODE_ROOTS) and has not been indexed before. ` +
        "Pass an explicit `path` once — it will be remembered for re-index by name.",
    );
  }
}

export class CodeRootsNotConfiguredError extends Error {
  constructor() {
    super(
      "No code roots configured or remembered. Set MEMORY_CODE_ROOTS (name=path,…) or pass `repo`/`path`.",
    );
  }
}

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RoundTestOptions {
  readonly runDirectory: string;
  readonly dataDirectory: string;
  readonly outputDirectory: string;
  readonly concurrency: number;
  readonly providerConcurrency: number;
  readonly workflowConcurrency: number;
  readonly repeats: number;
  readonly pollMs: number;
  readonly watch: boolean;
  readonly dryRun: boolean;
}

export function parseRoundTestArguments(argv: readonly string[]): RoundTestOptions {
  const names = new Set(["run-dir", "data-dir", "output-dir", "test-concurrency", "provider-concurrency", "workflow-concurrency", "test-repeats", "poll-ms", "watch", "dry-run"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!.slice(2);
    const value = argv[++index];
    if (!argv[index - 1]!.startsWith("--") || !names.has(key) || values.has(key) || value === undefined || value.startsWith("--")) throw new Error("Invalid Test Runner arguments");
    values.set(key, value);
  }
  for (const key of ["run-dir", "data-dir", "output-dir"]) if (!values.get(key)) throw new Error(`--${key} is required`);
  const integer = (key: string, fallback: string, maximum: number): number => {
    const number = Number(values.get(key) ?? fallback);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`--${key} must be in [1, ${maximum}]`);
    return number;
  };
  const boolean = (key: string, fallback: string): boolean => {
    const value = values.get(key) ?? fallback;
    if (value !== "true" && value !== "false") throw new Error(`--${key} must be true or false`);
    return value === "true";
  };
  const concurrency = integer("test-concurrency", process.env.DITTO_TEST_CONCURRENCY ?? "200", 4_096);
  const runDirectory = resolve(values.get("run-dir")!);
  const outputDirectory = resolve(values.get("output-dir")!);
  // A dedicated sibling output keeps the consumer completely separate from
  // all files read or written by the search process.
  const outputRelative = relative(runDirectory, outputDirectory);
  if (!outputRelative || (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error("Test outputs must be outside the search run directory");
  }
  return {
    runDirectory, dataDirectory: resolve(values.get("data-dir")!), outputDirectory, concurrency,
    providerConcurrency: integer("provider-concurrency", String(concurrency), 4_096),
    workflowConcurrency: integer("workflow-concurrency", "2", 32),
    repeats: integer("test-repeats", "3", 20), pollMs: integer("poll-ms", "2000", 60_000),
    watch: boolean("watch", "true"), dryRun: boolean("dry-run", "false"),
  };
}

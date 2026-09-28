import { resolve } from "node:path";
import { DATASETS, type DatasetName } from "./domain.js";

export interface ProviderSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
}

export function loadProviderSettings(env: NodeJS.ProcessEnv = process.env): ProviderSettings {
  const baseUrl = env.CODE_SOUL_BASE_URL ?? "https://api.code-soul.com/v1";
  const model = env.CODE_SOUL_MODEL ?? "qwen3.5:9b-32k";
  const apiKey = env.CODE_SOUL_API_KEY;
  if (!apiKey?.trim()) throw new Error("CODE_SOUL_API_KEY is required. Put it in an ignored .env file or the process environment.");
  const concurrency = integer(env.CODE_SOUL_CONCURRENCY ?? "3", "CODE_SOUL_CONCURRENCY", 1, 64);
  const timeoutMs = integer(env.CODE_SOUL_TIMEOUT_MS ?? "180000", "CODE_SOUL_TIMEOUT_MS", 1_000, 30 * 60_000);
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CODE_SOUL_BASE_URL must be a plain HTTP(S) URL without credentials, query, or fragment");
  }
  return Object.freeze({ baseUrl: url.href.replace(/\/$/, ""), model, apiKey, concurrency, timeoutMs });
}

export interface ExperimentOptions {
  readonly command: "search" | "test";
  readonly dataset: DatasetName;
  readonly dataDir: string;
  readonly runDir?: string;
  readonly outputRoot: string;
  readonly searchLimit: number;
  readonly testLimit: number;
  readonly rounds: number;
  readonly repeats: number;
  readonly evaluationConcurrency: number;
  readonly topK: number;
  readonly patience: number;
  readonly seed: number;
  readonly maximumDepth: number;
  readonly dockerImage: string;
}

const FLAGS = new Set([
  "dataset", "data-dir", "run-dir", "output-root", "search-limit", "test-limit", "rounds", "repeats",
  "evaluation-concurrency", "top-k", "patience", "seed", "maximum-depth", "docker-image",
]);

export function parseArguments(argv: readonly string[], cwd = process.cwd()): ExperimentOptions {
  const [rawCommand, ...rest] = argv;
  if (rawCommand !== "search" && rawCommand !== "test") {
    throw new Error(`Usage: cli.js <search|test> --dataset <${DATASETS.join("|")}> [options]`);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!FLAGS.has(key)) throw new Error(`Unknown option: --${key}`);
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
  }
  const rawDataset = values.get("dataset") ?? "math";
  if (!isDataset(rawDataset)) throw new Error(`Unsupported dataset: ${rawDataset}`);
  const runDir = values.get("run-dir");
  if (rawCommand === "test" && !runDir) throw new Error("test requires --run-dir <completed search run>");
  return Object.freeze({
    command: rawCommand,
    dataset: rawDataset,
    dataDir: resolve(cwd, values.get("data-dir") ?? "data/datasets"),
    ...(runDir ? { runDir: resolve(cwd, runDir) } : {}),
    outputRoot: resolve(cwd, values.get("output-root") ?? "runs"),
    searchLimit: integer(values.get("search-limit") ?? "12", "search-limit", 0, 100_000),
    testLimit: integer(values.get("test-limit") ?? "30", "test-limit", 0, 100_000),
    rounds: integer(values.get("rounds") ?? "4", "rounds", 1, 1_000),
    repeats: integer(values.get("repeats") ?? "1", "repeats", 1, 20),
    evaluationConcurrency: integer(values.get("evaluation-concurrency") ?? "3", "evaluation-concurrency", 1, 64),
    topK: integer(values.get("top-k") ?? "4", "top-k", 1, 100),
    patience: integer(values.get("patience") ?? "4", "patience", 1, 100),
    seed: integer(values.get("seed") ?? "42", "seed", 0, 0x7fffffff),
    maximumDepth: integer(values.get("maximum-depth") ?? "12", "maximum-depth", 2, 24),
    dockerImage: values.get("docker-image") ?? process.env.CODE_JUDGE_IMAGE ?? "python:3.13-slim",
  });
}

function isDataset(value: string): value is DatasetName {
  return (DATASETS as readonly string[]).includes(value);
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return parsed;
}

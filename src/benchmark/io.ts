import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function readJsonLines<T>(path: string, validate: (value: unknown, row: number) => T): Promise<readonly T[]> {
  const content = await readFile(path, "utf8");
  const rows: T[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON at ${path}:${index + 1}`, { cause: error });
    }
    rows.push(validate(value, index + 1));
  }
  if (!rows.length) throw new Error(`Dataset split is empty: ${path}`);
  return Object.freeze(rows);
}

export function requireRecord(value: unknown, path: string, row: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected an object at ${path}:${row}`);
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, path: string, row: number): string {
  if (typeof value !== "string") throw new Error(`Expected string field '${field}' at ${path}:${row}`);
  return value;
}

export function requireStringArray(value: unknown, field: string, path: string, row: number): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string[] field '${field}' at ${path}:${row}`);
  }
  return Object.freeze([...value] as string[]);
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const session = resolve(process.argv[2] ?? "");
const reference = resolve(process.argv[3] ?? "");
if (process.argv.length !== 4) throw new Error("Usage: prepare_math_session.mjs <new-session-directory> <frozen-aflow-reference>");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim();
if (dirty) throw new Error("Commit the experiment changes before freezing a session");
await access(join(repository, "dist/cli.js"));
const datasets = join(reference, "data/datasets");
const validationText = await readFile(join(datasets, "math_validate.jsonl"), "utf8");
const testText = await readFile(join(datasets, "math_test.jsonl"), "utf8");
const validationRows = validationText.trim().split(/\r?\n/);
const testRows = testText.trim().split(/\r?\n/);
if (validationRows.length !== 119 || testRows.length !== 486) throw new Error("Expected the frozen 119/486 MATH split");

// Exclusive creation: previous runs and their evidence must remain intact.
await mkdir(session);
const snapshot = join(session, "ditto-experiment");
const aflow = join(session, "aflow-reference");
await mkdir(snapshot);
await mkdir(aflow);
const filter = (path) => !path.split(/[\\/]/).includes("__pycache__") && !path.endsWith(".pyc");
for (const directory of ["src", "dist", "scripts"]) {
  await cp(join(repository, directory), join(snapshot, directory), { recursive: true, filter });
}
for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
  await copyFile(join(repository, file), join(snapshot, file));
}
await symlink(join(repository, "node_modules"), join(snapshot, "node_modules"), "junction");
for (const directory of ["benchmarks", "scripts"]) {
  await cp(join(reference, directory), join(aflow, directory), { recursive: true, filter });
}
await mkdir(join(aflow, "data/datasets"), { recursive: true });
for (const split of ["validate", "test"]) {
  await copyFile(join(datasets, `math_${split}.jsonl`), join(aflow, `data/datasets/math_${split}.jsonl`));
}

// Exercise freeze/test mechanics using validation fixtures only. Smoke outputs
// live outside the formal run, and no held-out test question is solved here.
await mkdir(join(session, "smoke-data"));
const fixture = `${validationRows.slice(0, 2).join("\n")}\n`;
for (const split of ["validate", "test"]) {
  await writeFile(join(session, `smoke-data/math_${split}.jsonl`), fixture, "utf8");
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = {};
async function hashTree(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await hashTree(path, key);
    else if (entry.isFile()) files[key] = hash(await readFile(path));
  }
}
for (const directory of ["src", "dist", "scripts"]) await hashTree(join(snapshot, directory), directory);
const lock = JSON.parse(await readFile(join(snapshot, "package-lock.json"), "utf8"));
await writeFile(join(session, "audit.json"), `${JSON.stringify({
  createdAt: new Date().toISOString(), session: basename(session), dittoCommit: commit,
  dittoVersion: lock.packages["node_modules/@codesoul-co/ditto"].version,
  referenceSource: reference,
  protocol: { validationExamples: 119, validationRepeats: 5, searchExpansionLimit: 20,
    includesSeparateBaseline: true, testExamples: 486, testRepeats: 3, concurrency: 3,
    topK: 4, convergenceTopK: 3, convergenceConsecutiveRounds: 5, seed: 42, maximumDepth: 10 },
  metricProfile: "aflow-symbolic-plus-balanced-normalized-v2",
  dataset: { validate: hash(validationText), test: hash(testText) },
  aflowScorer: hash(await readFile(join(aflow, "benchmarks/math.py"))),
  dittoLock: hash(await readFile(join(snapshot, "package-lock.json"))),
  dependencyDirectory: join(repository, "node_modules"),
  smoke: { rows: [1, 2], source: "validation-only", repeats: 1, searchExpansions: 1 },
  files,
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ phase: "snapshot-ready", session, commit, validation: 119, test: 486 }));

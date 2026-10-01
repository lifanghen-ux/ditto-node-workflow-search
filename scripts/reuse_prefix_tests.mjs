import { cp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { artifactHash, validateCheckpoint } from "../dist/run/checkpoints.js";

const [, , sourceArg, targetArg, runArg, maximumArg] = process.argv;
if (!sourceArg || !targetArg || !runArg || !maximumArg) throw new Error("Usage: reuse_prefix_tests.mjs <source-tests> <new-tests> <new-run> <maximum-prefix-index>");
const source = resolve(sourceArg), target = resolve(targetArg), run = resolve(runArg);
const maximum = Number(maximumArg);
if (!Number.isSafeInteger(maximum) || maximum < 1 || target === source) throw new Error("Invalid prefix cache target");
await mkdir(target, { recursive: true });
const copied = [], skipped = [];
for (const file of await readdir(join(run, "checkpoints"))) {
  const match = /^search-(\d+)\.json$/.exec(file);
  if (!match || Number(match[1]) > maximum) continue;
  const checkpoint = JSON.parse(await readFile(join(run, "checkpoints", file), "utf8"));
  validateCheckpoint(checkpoint);
  const jobDirectory = join(source, checkpoint.searchNodeId);
  const job = JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"));
  const key = artifactHash({ checkpoint, testDataHash: job.testDataHash, testRepeats: 3 });
  if (job.status !== "complete" || job.planHash !== checkpoint.planHash || job.key !== key || job.testRepeats !== 3) {
    skipped.push(checkpoint.searchNodeId); continue;
  }
  const summary = JSON.parse(await readFile(join(jobDirectory, `attempt-${job.attempt}`, "summary.json"), "utf8"));
  const samples = JSON.parse(await readFile(join(jobDirectory, `attempt-${job.attempt}`, "samples.json"), "utf8"));
  if (summary.examples !== 486 || summary.repeats !== 3 || samples.length !== 1458) throw new Error("Completed test cache is incomplete");
  await cp(jobDirectory, join(target, checkpoint.searchNodeId), { recursive: true, force: false, errorOnExist: true });
  copied.push(checkpoint.searchNodeId);
}
const record = { at: new Date().toISOString(), source, target, copied, skipped, resultsReturnedToSearch: false };
await writeFile(join(target, "prefix-cache-import.json"), JSON.stringify(record, null, 2)+"\n", "utf8");
console.log(JSON.stringify(record));

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightReport } from "./night_report.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ditto-night-"));
  const run = join(directory, "search");
  const tests = join(directory, "tests");
  const json = async (path, value) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
  await json(join(run, "manifest.json"), { status: "frozen", model: "fixture", best: { leafId: "search-002" },
    search: { rounds: 20, repeats: 5 }, data: { selectedExamples: 119 } });
  await json(join(run, "resume-state.json"), { completedRounds: 2, bestLeafId: "search-002" });
  for (const [id, validation, score] of [["search-002", .99, .8], ["search-003", .98, 1]]) {
    await json(join(run, "checkpoints", `${id}.json`), { planHash: `hash-${id}`, plan: { nodes: [{ type: "INFER.REASONING.SAMPLE" }] } });
    await json(join(run, "evaluations", id, "summary.json"), { score: validation, failedRuns: 0 });
    await json(join(tests, id, "job.json"), { planHash: `hash-${id}`, status: "complete", attempt: 1, legacyScore: score });
    await json(join(tests, id, "attempt-1", "summary.json"), { score, failedRuns: 0 });
  }
  return { directory, run, tests, json };
}

test("overnight completion uses the validation-selected best, never the highest test score", async () => {
  const f = await fixture();
  try {
    const searchBefore = await readFile(join(f.run, "manifest.json"), "utf8");
    const result = await nightReport(f.directory, f.run, f.tests);
    assert.equal(result.complete, true);
    assert.equal(result.bestId, "search-002");
    assert.equal(result.testScore, .8);
    assert.equal(await readFile(join(f.run, "manifest.json"), "utf8"), searchBefore);
    const report = JSON.parse(await readFile(join(f.directory, "overnight-results.json"), "utf8"));
    assert.equal(report.scoresReturnedToSearch, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a reused search vertex with a different plan hash cannot inherit an old test score", async () => {
  const f = await fixture();
  try {
    await f.json(join(f.tests, "search-002", "job.json"), { status: "complete", planHash: "other-plan", attempt: 1 });
    const result = await nightReport(f.directory, f.run, f.tests);
    assert.equal(result.complete, false);
    assert.equal(result.testScore, null);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

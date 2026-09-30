import { readFile, readdir, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export async function nightReport(session, runDirectory, testDirectory, guard = {}) {
  const readJson = async (path) => {
    try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const manifest = await readJson(join(runDirectory, "manifest.json"));
  if (!manifest) throw new Error("The active search manifest does not exist");
  const state = await readJson(join(runDirectory, "resume-state.json"));
  const rows = [];
  const checkpoints = (await readdir(join(runDirectory, "checkpoints"))).filter(name => /^search-\d+\.json$/.test(name)).sort();
  for (const filename of checkpoints) {
    const id = filename.replace(/\.json$/, "");
    const checkpoint = await readJson(join(runDirectory, "checkpoints", filename));
    const validation = await readJson(join(runDirectory, "evaluations", id, "summary.json"));
    const job = await readJson(join(testDirectory, id, "job.json"));
    // A failed/restarted branch can reuse a vertex number. Never match scores
    // using only that number; require the exact immutable plan hash as well.
    const matching = job?.planHash === checkpoint.planHash;
    const test = matching && job.status === "complete"
      ? await readJson(join(testDirectory, id, `attempt-${job.attempt}`, "summary.json")) : null;
    rows.push({ id, planHash: checkpoint.planHash, nodes: checkpoint.plan.nodes.map(node => node.type),
      validation, test, legacyTestScore: matching ? job?.legacyScore : null,
      testStatus: matching ? job.status : "not-submitted", testError: matching ? job.error : null });
  }
  const frozen = ["frozen", "complete"].includes(manifest.status);
  const complete = frozen && rows.length > 0 && rows.every(row => row.testStatus === "complete" && row.test);
  // The final workflow is selected ONLY by the search manifest's validation
  // decision. Test accuracy is not used for choosing or ranking workflows.
  const bestId = frozen ? manifest.best?.leafId : state?.bestLeafId;
  const report = { updatedAt: new Date().toISOString(), phase: complete ? "complete" : manifest.status,
    model: manifest.model, runDirectory, testDirectory, completedSearchRounds: state?.completedRounds ?? 0,
    searchRoundLimit: manifest.search.rounds, validationExamples: manifest.data.selectedExamples,
    validationRepeats: manifest.search.repeats, testExamples: 486, testRepeats: 3,
    frozen, validationSelectedBestId: bestId, final: frozen ? rows.find(row => row.id === bestId) ?? null : null,
    rows, recoveryAttempts: guard.searchRestarts ?? 0, scoresReturnedToSearch: false };
  const pct = value => typeof value === "number" ? `${(100 * value).toFixed(4)}%` : "pending";
  const text = ["Ditto MATH overnight results", `Updated (UTC): ${report.updatedAt}`,
    `Status: ${report.phase}; search rounds: ${report.completedSearchRounds}/${report.searchRoundLimit}`,
    "Validation: 119 questions x 5; fixed held-out test: 486 questions x 3.",
    "Test scores are recorded only, NEVER returned to optimizer/experience/parent selection.",
    `Validation-selected best: ${bestId ?? "pending"}; frozen: ${frozen}`,
    "ID\tvalidation accuracy\ttest accuracy\tlegacy test accuracy\ttest status\tvalidation failures\ttest failures",
    ...rows.map(row => [row.id, pct(row.validation?.score), pct(row.test?.score), pct(row.legacyTestScore),
      row.testStatus, row.validation?.failedRuns ?? "pending", row.test?.failedRuns ?? "pending"].join("\t")),
    "", `Automatic search recovery attempts: ${report.recoveryAttempts}`,
    "Incomplete attempts are retained in their original folders; they are not blended into full evaluations.",
    `Active search: ${runDirectory}`, `Active tests: ${testDirectory}`, ""].join("\n");
  await mkdir(session, { recursive: true });
  for (const [name, contents] of [["overnight-results.json", `${JSON.stringify(report, null, 2)}\n`], ["overnight-results.txt", text]]) {
    const path = join(session, name);
    const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  }
  return { phase: report.phase, complete, frozen, rows: rows.length, failedJobs: rows.filter(row => row.testStatus === "failed").length,
    bestId, testScore: report.final?.test?.score ?? null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , session, run, tests, guardPath] = process.argv;
  let guard = {};
  if (guardPath) guard = JSON.parse((await readFile(guardPath, "utf8")).replace(/^\uFEFF/, ""));
  console.log(JSON.stringify(await nightReport(resolve(session), resolve(run), resolve(tests), guard)));
}

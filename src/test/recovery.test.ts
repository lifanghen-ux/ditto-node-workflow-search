import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { EvaluationSummary, NodeProposal } from "../domain.js";
import { NodeWorkflowSearch, type SearchResumeState } from "../search/optimizer.js";
import { loadHistoricalResume } from "../run/resume.js";
import { RunStore } from "../run/store.js";
import { renameArtifact } from "../run/atomic.js";

test("Windows sharing violations retry atomic rename without deleting or overwriting artifacts", async () => {
  let attempts = 0;
  await renameArtifact("fixture.tmp", "fixture.json", async (from, to) => {
    assert.equal(from, "fixture.tmp"); assert.equal(to, "fixture.json");
    if (++attempts < 4) throw Object.assign(new Error("sharing"), { code: "EPERM" });
  }, async () => undefined);
  assert.equal(attempts, 4);
  let nonTransient = 0;
  await assert.rejects(renameArtifact("fixture.tmp", "fixture.json", async () => {
    nonTransient++; throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }, async () => undefined));
  assert.equal(nonTransient, 1);
});

test("an earlier boundary in a resumed run replays the inherited prefix and excludes subsequent corrupt rounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-resume-chain-"));
  try {
    const settings = { seed: 42, topK: 4, maximumDepth: 10 };
    const run = async (rounds: number, resume?: SearchResumeState, source?: string) => {
      const store = await RunStore.create(directory, "math");
      await store.writeManifest({ search: settings,
        ...(source ? { resumedFrom: { directory: source, completedSearchRounds: resume!.completedRounds } } : {}) });
      const result = await new NodeWorkflowSearch({ rounds, topK: 4, patience: 20, maxDepth: 10, seed: 42,
        ...(resume ? { resume } : {}),
        async evaluate(plan): Promise<EvaluationSummary> {
          const score = Number(plan.leafSearchNodeId.split("-")[1]) / 100;
          return { score, standardDeviation: 0, repeats: 1, examples: 1, successfulRuns: 1, failedRuns: 0,
            timeoutRuns: 0, wrongRuns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1,
            results: [{ caseId: "private:1", score, expected: "1", prediction: "1", normalizedExpected: "1", normalizedPrediction: "1",
              method: "fixture", latencyMs: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }] };
        }, proposer: {
          async propose(request): Promise<NodeProposal> {
            return { type: "INFER.REASONING.SAMPLE", graphId: "solve", dependencies: [],
              config: { role: "solver", instruction: `candidate-${request.experiences.length}-${request.path.length}`,
                generation: { temperature: .2, maxTokens: 2048 } } };
          },
        }, callbacks: {
          async node(node, experience) {
            await store.saveSearchNode(node);
            if (node.evaluation) await store.saveEvaluation(node.id, node.evaluation);
            if (experience) await store.saveExperience(experience);
          }, async event(value) { await store.appendEvent(value); },
          async state(value) { await store.saveResumeState(value); },
        },
      }).run();
      return { result, directory: store.directory };
    };
    const first = await run(2);
    const boundary2 = await loadHistoricalResume(first.directory, 2);
    const second = await run(8, boundary2.state, first.directory);
    const before = await readFile(join(second.directory, "resume-state.json"), "utf8");
    const recovered = await loadHistoricalResume(second.directory, 6);
    const uninterrupted = await run(6);
    assert.equal(recovered.state.completedRounds, 6);
    assert.deepEqual(recovered.state.nodes, uninterrupted.result.nodes);
    assert.deepEqual(recovered.state.experiences, uninterrupted.result.experiences);
    assert.equal(recovered.state.nextSearchIndex, 8);
    assert.equal(await readFile(join(second.directory, "resume-state.json"), "utf8"), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

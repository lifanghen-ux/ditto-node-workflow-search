import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION } from "../protocol.js";
import { parseNodeProposal } from "../search/proposer.js";

test("optimizer parser accepts exactly one allowlisted Ditto Node proposal", () => {
  const proposal = parseNodeProposal(`\`\`\`json
  {
    "type":"INFER.REASONING.REFLECT",
    "graphId":"refine",
    "dependencies":[],
    "config":{
      "mode":"revise",
      "criteria":["correctness","output contract"],
      "generation":{"temperature":${GENERATION.temperature},"maxTokens":${GENERATION.maxTokens}}
    }
  }
  \`\`\``);

  assert.deepEqual(proposal, {
    type: "INFER.REASONING.REFLECT",
    graphId: "refine",
    dependencies: [],
    config: {
      mode: "revise",
      criteria: ["correctness", "output contract"],
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
    },
  });
  assert.equal("id" in proposal, false, "IDs must be assigned only by trusted code");
});

test("optimizer parser rejects unknown Nodes and executable-code fields", () => {
  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.UNKNOWN",
    graphId: "solve",
    dependencies: [],
    config: {},
  })), /Unsupported or non-searchable Ditto Node/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.SAMPLE",
    graphId: "solve",
    dependencies: [],
    config: {
      role: "solver",
      instruction: "Solve the task.",
      generation: { temperature: 0.2, maxTokens: 512 },
    },
    code: "process.exit(0)",
  })), /Unexpected field: code/);

  const valid = JSON.stringify({
    type: "INFER.REASONING.SAMPLE",
    graphId: "solve",
    dependencies: [],
    config: {
      role: "solver",
      instruction: "Solve the task.",
      generation: { temperature: 0.2, maxTokens: 512 },
    },
  });
  assert.throws(() => parseNodeProposal(`${valid}\n${valid}`), /exactly one Node proposal/);
});

test("optimizer parser enforces Graph placement and dependency shape", () => {
  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.TRAJECTORY",
    graphId: "refine",
    dependencies: [],
    config: {
      instruction: "Solve the task.",
      strategy: "cot",
      options: { rounds: 1 },
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
      maxSteps: 8,
    },
  })), /TRAJECTORY graphId must be solve/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.DELIBERATE",
    graphId: "solve",
    dependencies: ["trajectory-1", "trajectory-1"],
    config: {
      mode: "select",
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
    },
  })), /dependencies must not contain duplicates/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.TRAJECTORY",
    graphId: "solve",
    dependencies: [],
    config: {
      instruction: "Solve the task.",
      strategy: "tot",
      options: { breadth: 2, depth: 2 },
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
      maxSteps: 8,
    },
  })), /Missing tot option: beamWidth/);
});

test("optimizer repairs illegal options and cross-Graph dependencies with raw rejection feedback", async () => {
  const { createDitto } = await import("@codesoul-co/ditto/runtime");
  const { createInferWorker } = await import("@codesoul-co/ditto/worker/infer");
  const { NextNodeProposer } = await import("../search/proposer.js");
  const { createRootNode, createInitialSampleNode, instantiateProposal, validateNodePath } = await import("../workflow/spec.js");
  const path = [createRootNode(), createInitialSampleNode()];
  const invalidOptions = JSON.stringify({ type: "INFER.REASONING.TRAJECTORY", graphId: "solve", dependencies: [], config: { instruction: "Solve", strategy: "cot", options: { rounds: 1, selfCheck: true }, generation: GENERATION } });
  const invalidDependency = JSON.stringify({ type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: ["sample-1"], config: { mode: "verify", criteria: ["correctness"], generation: GENERATION } });
  const valid = JSON.stringify({ type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [], config: { mode: "verify", criteria: ["correctness"], generation: GENERATION } });
  const raw = [invalidOptions, invalidDependency, valid];
  let calls = 0;
  const rejected: { content: string; error: string }[] = [];
  const runtime = createDitto({ workers: [createInferWorker({ defaultProvider: "fixture", providers: { fixture: { async invoke(input) {
    assert.match(String(input.messages[0]?.content), /Do not invent options such as selfCheck/);
    const request = JSON.parse(String(input.messages[1]?.content)) as { legalDependenciesByGraph: Record<string, string[]>; rejectedProposals?: { content: string }[] };
    assert.deepEqual(request.legalDependenciesByGraph.refine, []);
    assert.equal(request.rejectedProposals?.length ?? 0, calls);
    if (calls > 0) assert.equal(request.rejectedProposals?.at(-1)?.content, raw[calls - 1]);
    return { message: { role: "assistant", content: raw[calls++]! }, finishReason: "stop" };
  } } } })] });
  try {
    const proposal = await new NextNodeProposer(runtime, "fixture", "fixture").propose({ path, experiences: [], taskGoal: "offline repair", validate: (value) => validateNodePath([...path, instantiateProposal(value, "candidate")]), onRejection: async (value) => { rejected.push(value); } });
    assert.equal(proposal.type, "INFER.REASONING.REFLECT");
    assert.equal(calls, 3);
    assert.deepEqual(rejected.map((item) => item.content), [invalidOptions, invalidDependency]);
    assert.match(rejected[0]!.error, /selfCheck must be an integer/);
    assert.match(rejected[1]!.error, /cross-Graph/);
  } finally { await runtime.close(); }
});

test("optimizer provider request omits private reference solutions, hidden tests and judge assertions", async () => {
  const { createDitto } = await import("@codesoul-co/ditto/runtime");
  const { createInferWorker } = await import("@codesoul-co/ditto/worker/infer");
  const { NextNodeProposer } = await import("../search/proposer.js");
  const { createRootNode, createInitialSampleNode } = await import("../workflow/spec.js");
  const path = [createRootNode(), createInitialSampleNode()];
  const privateGold = "PRIVATE_GOLD_SOLUTION_SENTINEL";
  const privateTest = "PRIVATE_HIDDEN_TEST_SENTINEL";
  const privateAssertion = "PRIVATE_TOOL_ASSERTION_SENTINEL";
  let calls = 0;
  const runtime = createDitto({ workers: [createInferWorker({ defaultProvider: "fixture", providers: {
    fixture: { async invoke(input) {
      calls++;
      const wire = JSON.stringify(input);
      for (const sentinel of [privateGold, privateTest, privateAssertion]) assert.equal(wire.includes(sentinel), false);
      assert.match(String(input.messages[0]?.content), /Expected answers.*omitted/);
      const request = JSON.parse(String(input.messages[1]?.content));
      assert.deepEqual(request.experience[0].failures, [{ caseId: "public-case", prediction: "public model prediction" }]);
      assert.equal(request.experience[0].score, 0);
      return { message: { role: "assistant", content: JSON.stringify({
        type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [],
        config: { mode: "verify", criteria: ["Check constraints"], generation: GENERATION },
      }) }, finishReason: "stop" };
    } },
  } })] });
  const failures = [{ caseId: "public-case", prediction: "public model prediction",
    expected: `${privateGold} ${privateTest}`, error: `${privateAssertion} ${privateTest}` }];
  try {
    await new NextNodeProposer(runtime, "fixture", "fixture").propose({
      path, taskGoal: "offline privacy regression", experiences: [{
        searchNodeId: "node", parentSearchNodeId: null, node: path[1]!,
        score: 0, delta: null, outcome: "root", failures,
      }],
    });
    assert.equal(calls, 1);
    assert.equal(failures[0]!.expected, `${privateGold} ${privateTest}`, "local evidence must stay intact");
    assert.equal(failures[0]!.error, `${privateAssertion} ${privateTest}`);
  } finally { await runtime.close(); }
});

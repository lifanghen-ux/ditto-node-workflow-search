import assert from "node:assert/strict";
import test from "node:test";
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
      "generation":{"temperature":0.2,"maxTokens":1024}
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
      generation: { temperature: 0.2, maxTokens: 1024 },
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
      generation: { temperature: 0.2, maxTokens: 1024 },
      maxSteps: 8,
    },
  })), /TRAJECTORY graphId must be solve/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.DELIBERATE",
    graphId: "solve",
    dependencies: ["trajectory-1", "trajectory-1"],
    config: {
      mode: "select",
      generation: { temperature: 0.2, maxTokens: 1024 },
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
      generation: { temperature: 0.2, maxTokens: 1024 },
      maxSteps: 8,
    },
  })), /Missing tot option: beamWidth/);
});

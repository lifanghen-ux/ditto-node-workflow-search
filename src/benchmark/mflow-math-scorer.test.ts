import assert from "node:assert/strict";
import test from "node:test";
import { MFlowMathScorer } from "./mflow-math-scorer.js";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

test("canonical MFlow scorer accepts equivalent answers and rejects wrong, empty and malformed outputs", {
  skip: !(process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON)
    && "Set MATH_SCORER_PYTHON to the pinned math-verify 0.9.0 interpreter for native scorer integration tests",
}, async () => {
  const scorer = new MFlowMathScorer(new Map([["fraction", String.raw`\boxed{\frac{1}{2}}`], ["integer", String.raw`\boxed{7}`]]));
  await scorer.preflight();
  for (const [id, answer, expected] of [
    ["fraction", "0.5", 1],
    ["fraction", String.raw`\frac{2}{4}`, 1],
    ["fraction", String.raw`\boxed{\frac{1}{3}}`, 0],
    ["integer", "", 0],
    ["integer", String.raw`\boxed{`, 0],
    ["integer", String.raw`\boxed{8}`, 0],
  ] as const) {
    const result = await scorer.score(id, answer);
    assert.equal(result.score, expected, answer);
    assert.equal(result.method, "mflow-math-verify-0.9.0");
  }
  await assert.rejects(scorer.score("unknown", "7"), /Unknown MATH task/);
});

test("native scorer accepts predictions beyond Windows' command-line limit through stdin", {
  skip: !(process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON),
}, async () => {
  const scorer = new MFlowMathScorer(new Map([["long", String.raw`\boxed{7}`]]));
  const prediction = "推导步骤。".repeat(14_000) + String.raw`\boxed{7}`;
  assert.ok(prediction.length > 32_767);
  const result = await scorer.score("long", prediction);
  assert.equal(result.score, 1);
  assert.equal(result.prediction, prediction);
});

test("native scorer keeps CLI compatibility and rejects malformed stdin as an error", {
  skip: !(process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON),
}, async () => {
  const python = process.env.MATH_SCORER_PYTHON || process.env.AFLOW_SCORER_PYTHON!;
  const script = fileURLToPath(new URL("../../scripts/mflow_math_scorer.py", import.meta.url));
  const invoke = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
    const child = execFile(python, args, { timeout: 30_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.on("error", (error) => { child.kill(); reject(error); });
    child.stdin!.end(input ?? "", "utf8");
  });
  const record = JSON.stringify({ gold: String.raw`\boxed{7}`, answer: String.raw`\boxed{7}` });
  assert.equal((await invoke([script, record])).trim(), "1");
  assert.equal((await invoke([script], record)).trim(), "1");
  await assert.rejects(invoke([script], "not valid JSON"), /JSONDecodeError|Command failed/);
});

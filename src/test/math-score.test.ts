import assert from "node:assert/strict";
import test from "node:test";
import { extractLastBoxed, normalizeMath, scoreMathAnswer } from "../benchmark/math-score.js";

test("extractLastBoxed handles nesting and chooses the last answer", () => {
  const value = String.raw`first \boxed{1}, final \boxed{\frac{1}{\sqrt{2}}}`;
  assert.equal(extractLastBoxed(value), String.raw`\frac{1}{\sqrt{2}}`);
});

test("scoreMathAnswer recognizes normalized and numeric fractions", () => {
  const exact = scoreMathAnswer(String.raw`Thus \boxed{\dfrac{1}{2}}.`, String.raw`Answer: \boxed{\frac{1}{2}}`);
  assert.equal(exact.score, 1);
  assert.equal(exact.equivalence, "exact");

  const numeric = scoreMathAnswer(String.raw`Thus \boxed{0.5}.`, String.raw`Answer: \boxed{\frac{1}{2}}`);
  assert.equal(numeric.score, 1);
  assert.equal(numeric.equivalence, "numeric");
});

test("missing boxed answer is a visible scoring failure", () => {
  const result = scoreMathAnswer(String.raw`Thus \boxed{7}.`, "The answer is 7.");
  assert.equal(result.score, 0);
  assert.equal(result.extraction, "missing-box");
  assert.equal(normalizeMath(" { 7 } "), "7");
});

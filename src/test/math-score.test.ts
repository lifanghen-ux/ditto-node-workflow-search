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

test("an explicit plain answer does not require a box", () => {
  assert.equal(scoreMathAnswer(String.raw`Thus \boxed{7}.`, "The answer is 7.").score, 1);
  const result = scoreMathAnswer(String.raw`Thus \boxed{7}.`, "We tried 7 but could not solve it.");
  assert.equal(result.score, 0);
  assert.equal(result.extraction, "missing-box");
  assert.equal(normalizeMath(" { 7 } "), "7");
});

test("declared Markdown and mathematical answers are extracted without consulting gold", () => {
  const cases = [
    ["3", "Working: 12, 36.\n\n**Answer: 3 bad workers.**"],
    ["200", "14.7923412 squared is about 218.813.\nTo the nearest hundred, that is **200**."],
    ["36", "Work: 170n = 180n - 360.\nSo the polygon has **36 sides**."],
    ["MAKE", "**MAKE**\n\nValues: M = 13, A = 1, K = 11, E = 5."],
    ["Devon", "The highest rounded number is **12,350**, so **Devon wins**."],
    ["22", "Rounded to the nearest whole number: **22 more euros than pounds**."],
    ["5k", String.raw`\[\frac{k-3}{2}+3k+1+\frac{3k+1}{2}=5k\]`],
  ];
  for (const [gold, prediction] of cases) {
    assert.equal(scoreMathAnswer(`\\boxed{${gold}}`, prediction!).score, 1, prediction);
    assert.equal(scoreMathAnswer("\\boxed{999999}", prediction!).score, 0, prediction);
  }
});

test("explicit wrong or ambiguous answers cannot recover a matching intermediate value", () => {
  for (const prediction of ["We first got **7**.\nAnswer: 8", "Answer: 7 or 8", "Answer: not 7", "We calculated 7 before continuing."]) {
    assert.equal(scoreMathAnswer("\\boxed{7}", prediction).score, 0, prediction);
  }
});

test("standard MATH normalization ignores presentation-only units and equivalent matrix fractions", () => {
  assert.equal(scoreMathAnswer("Answer: \\boxed{100\\text{ square units}}", "\\boxed{100}").score, 1);
  assert.equal(scoreMathAnswer("Answer: \\boxed{120^\\circ}", "\\boxed{120}").score, 1);
  assert.equal(
    scoreMathAnswer(
      "Answer: \\boxed{\\begin{pmatrix} 1/5 \\\\ -18/5 \\end{pmatrix}}",
      "\\boxed{\\begin{pmatrix}\\frac{1}{5}\\\\-\\frac{18}{5}\\end{pmatrix}}",
    ).score,
    1,
  );
});

test("an explicit trailing sequence of boxed reference values matches one boxed list", () => {
  const gold = "This gives $a=\\boxed{-1}$ and $a=\\boxed{2}$.";
  assert.equal(scoreMathAnswer(gold, "\\boxed{-1,2}").score, 1);
  assert.equal(scoreMathAnswer("First $\\boxed{-1}$. Therefore $\\boxed{2}$.", "\\boxed{-1,2}").score, 0);
});

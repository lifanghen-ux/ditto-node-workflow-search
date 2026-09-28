export interface MathScore {
  readonly score: 0 | 1;
  readonly expected: string;
  readonly prediction: string;
  readonly normalizedExpected: string;
  readonly normalizedPrediction: string;
  readonly extraction: "boxed" | "missing-box";
  readonly equivalence: "exact" | "numeric" | "none";
}

export function scoreMathAnswer(goldSolution: string, modelOutput: string): MathScore {
  const expected = extractLastBoxed(goldSolution);
  if (expected === undefined) throw new Error("Gold MATH solution does not contain a balanced \\boxed answer");
  const predicted = extractLastBoxed(modelOutput);
  const normalizedExpected = normalizeMath(expected);
  const normalizedPrediction = predicted === undefined ? "" : normalizeMath(predicted);
  if (predicted === undefined) {
    return { score: 0, expected, prediction: "", normalizedExpected, normalizedPrediction, extraction: "missing-box", equivalence: "none" };
  }
  if (normalizedPrediction === normalizedExpected) {
    return { score: 1, expected, prediction: predicted, normalizedExpected, normalizedPrediction, extraction: "boxed", equivalence: "exact" };
  }
  const left = numericValue(normalizedPrediction);
  const right = numericValue(normalizedExpected);
  if (left !== undefined && right !== undefined && Math.abs(left - right) <= 1e-3) {
    return { score: 1, expected, prediction: predicted, normalizedExpected, normalizedPrediction, extraction: "boxed", equivalence: "numeric" };
  }
  return { score: 0, expected, prediction: predicted, normalizedExpected, normalizedPrediction, extraction: "boxed", equivalence: "none" };
}

/** Balanced-brace parser; unlike the AFlow regex, nested fractions remain intact. */
export function extractLastBoxed(text: string): string | undefined {
  const marker = "\\boxed{";
  let cursor = 0;
  let latest: string | undefined;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    let depth = 1;
    let index = start + marker.length;
    const contentStart = index;
    for (; index < text.length; index++) {
      const character = text[index]!;
      if (character === "{" && !escaped(text, index)) depth++;
      else if (character === "}" && !escaped(text, index)) {
        depth--;
        if (depth === 0) {
          latest = text.slice(contentStart, index).trim();
          index++;
          break;
        }
      }
    }
    cursor = Math.max(index, start + marker.length);
  }
  return latest;
}

export function normalizeMath(value: string): string {
  let result = value.normalize("NFKC").trim();
  result = result.replace(/^\$+|\$+$/g, "");
  result = result.replace(/\\(?:left|right)/g, "");
  result = result.replace(/\\(?:dfrac|tfrac)/g, "\\frac");
  result = result.replace(/\\(?:,|!|;|:|quad|qquad)/g, "");
  result = result.replace(/\s+/g, "");
  result = result.replace(/\{,\}/g, "");
  result = stripOuterBraces(result);
  return result;
}

function numericValue(value: string): number | undefined {
  let text = stripOuterBraces(value.replace(/,/g, ""));
  let scale = 1;
  if (text.endsWith("\\%")) {
    text = text.slice(0, -2);
    scale = 0.01;
  } else if (text.endsWith("%")) {
    text = text.slice(0, -1);
    scale = 0.01;
  }
  const number = Number(text);
  if (Number.isFinite(number)) return number * scale;

  const fraction = parseTwoBalancedArguments(text, "\\frac");
  if (fraction) {
    const numerator = numericValue(fraction[0]);
    const denominator = numericValue(fraction[1]);
    if (numerator !== undefined && denominator !== undefined && denominator !== 0) return (numerator / denominator) * scale;
  }
  const slash = text.match(/^([-+]?\d+(?:\.\d+)?)\/([-+]?\d+(?:\.\d+)?)$/);
  if (slash) {
    const denominator = Number(slash[2]);
    if (denominator !== 0) return (Number(slash[1]) / denominator) * scale;
  }
  const squareRoot = parseOneBalancedArgument(text, "\\sqrt");
  if (squareRoot !== undefined) {
    const radicand = numericValue(squareRoot);
    if (radicand !== undefined && radicand >= 0) return Math.sqrt(radicand) * scale;
  }
  if (text === "\\pi" || text === "pi") return Math.PI * scale;
  const pi = text.match(/^([-+]?\d+(?:\.\d+)?)?(?:\\pi|pi)$/);
  if (pi) return Number(pi[1] ?? "1") * Math.PI * scale;
  return undefined;
}

function parseOneBalancedArgument(text: string, prefix: string): string | undefined {
  if (!text.startsWith(`${prefix}{`) || !text.endsWith("}")) return undefined;
  const start = prefix.length;
  const end = matchingBrace(text, start);
  return end === text.length - 1 ? text.slice(start + 1, end) : undefined;
}

function parseTwoBalancedArguments(text: string, prefix: string): readonly [string, string] | undefined {
  if (!text.startsWith(`${prefix}{`)) return undefined;
  const firstStart = prefix.length;
  const firstEnd = matchingBrace(text, firstStart);
  if (firstEnd < 0 || text[firstEnd + 1] !== "{") return undefined;
  const secondStart = firstEnd + 1;
  const secondEnd = matchingBrace(text, secondStart);
  if (secondEnd !== text.length - 1) return undefined;
  return [text.slice(firstStart + 1, firstEnd), text.slice(secondStart + 1, secondEnd)];
}

function matchingBrace(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "{" && !escaped(text, index)) depth++;
    else if (text[index] === "}" && !escaped(text, index) && --depth === 0) return index;
  }
  return -1;
}

function stripOuterBraces(value: string): string {
  let result = value;
  while (result.startsWith("{") && matchingBrace(result, 0) === result.length - 1) result = result.slice(1, -1);
  return result;
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

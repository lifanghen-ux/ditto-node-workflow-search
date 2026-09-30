export interface MathScore {
  readonly score: 0 | 1;
  readonly expected: string;
  readonly prediction: string;
  readonly normalizedExpected: string;
  readonly normalizedPrediction: string;
  readonly extraction: "boxed" | "explicit-answer" | "emphasized-answer" | "math-answer" | "bare-answer" | "missing-box";
  readonly equivalence: "exact" | "numeric" | "none";
}

export function scoreMathAnswer(goldSolution: string, modelOutput: string): MathScore {
  const expected = extractLastBoxed(goldSolution);
  if (expected === undefined) throw new Error("Gold MATH solution does not contain a balanced \\boxed answer");
  const extracted = extractMathAnswer(modelOutput);
  const predicted = extracted?.answer;
  const extraction = extracted?.extraction ?? "missing-box";
  const normalizedExpected = normalizeMath(expected);
  const normalizedPrediction = predicted === undefined ? "" : normalizeMath(predicted);
  if (predicted === undefined) {
    return { score: 0, expected, prediction: "", normalizedExpected, normalizedPrediction, extraction: "missing-box", equivalence: "none" };
  }
  if (normalizedPrediction === normalizedExpected) {
    return { score: 1, expected, prediction: predicted, normalizedExpected, normalizedPrediction, extraction, equivalence: "exact" };
  }
  const left = numericValue(normalizedPrediction);
  const right = numericValue(normalizedExpected);
  if (left !== undefined && right !== undefined && Math.abs(left - right) <= 1e-3) {
    return { score: 1, expected, prediction: predicted, normalizedExpected, normalizedPrediction, extraction, equivalence: "numeric" };
  }
  const listExpected = trailingBoxedList(goldSolution, predicted);
  if (listExpected !== undefined) {
    return {
      score: 1,
      expected: listExpected,
      prediction: predicted,
      normalizedExpected: normalizeMath(listExpected),
      normalizedPrediction,
      extraction,
      equivalence: "exact",
    };
  }
  return { score: 0, expected, prediction: predicted, normalizedExpected, normalizedPrediction, extraction, equivalence: "none" };
}

/** Select a declared answer using output syntax only, never the reference value.
 * The raw-problem baseline does not request boxes, so prose/Markdown final
 * answers must be accepted too. Never search arbitrary intermediate numbers.
 */
export function extractMathAnswer(output: string): {
  readonly answer: string;
  readonly extraction: MathScore["extraction"];
} | undefined {
  const boxed = extractLastBoxed(output);
  if (boxed !== undefined) return { answer: boxed, extraction: "boxed" };
  const text = output.trim();
  const labels = [...text.matchAll(/(?:^|\n|\b)(?:final\s+)?answer\s*(?::|=|is\b)\s*([^\n]*)/gi)];
  const label = labels.at(-1);
  if (label) {
    const answer = cleanDeclaredAnswer(label[1]!);
    // An explicit but unparsable answer must not fall back to an earlier value.
    return answer === undefined ? undefined : { answer, extraction: "explicit-answer" };
  }
  const bold = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)];
  const finalBold = bold.at(-1);
  if (finalBold && /^[\s.!]*$/.test(text.slice(finalBold.index! + finalBold[0].length))) {
    const answer = cleanDeclaredAnswer(finalBold[1]!);
    return answer === undefined ? undefined : { answer, extraction: "emphasized-answer" };
  }
  // A standalone opening answer followed by an explanation is common for
  // word-valued questions. Other highlighted values make it ambiguous.
  if (bold.length === 1 && /^\*\*[^*\n]+\*\*\s*\n\s*\n/.test(text)) {
    const answer = cleanDeclaredAnswer(bold[0]![1]!);
    if (answer !== undefined) return { answer, extraction: "emphasized-answer" };
  }
  const math = text.match(/(?:\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$)[\s.!]*$/);
  if (math) {
    const answer = cleanDeclaredAnswer(math[1] ?? math[2] ?? math[3] ?? math[4]!);
    if (answer !== undefined) return { answer, extraction: "math-answer" };
  }
  const answer = cleanDeclaredAnswer(text);
  return answer === undefined ? undefined : { answer, extraction: "bare-answer" };
}

function cleanDeclaredAnswer(value: string): string | undefined {
  let text = value.trim().replace(/\*\*|__/g, "").replace(/[.!]+$/, "").trim();
  text = text.replace(/^\\\[|\\\]$|^\\\(|\\\)$|^\$+|\$+$/g, "").trim();
  if (text.includes("\n") && !text.includes("=")) return undefined;
  // Use the final right-hand side of an equation, retaining complete lists.
  if (text.includes("=") && !/[<>]|\\(?:le|ge|neq)/.test(text)) text = text.slice(text.lastIndexOf("=") + 1).trim();
  const units = /\s+(?:(?:square|cubic|bad|good)\s+)?(?:units?|cents?|degrees?|workers?|sides?|feet|foot|inches|meters?|metres?|cm|mm|miles?|euros?|pounds?|dollars?|minutes?|hours?|seconds?|days?)$/i;
  text = text.replace(/\s+(?:more|fewer)\s+(?:euros?|pounds?|dollars?|cents?)\s+than\s+(?:euros?|pounds?|dollars?|cents?)$/i, "").replace(units, "").trim();
  text = text.replace(/^([A-Za-z][A-Za-z'-]*)\s+(?:wins|is the winner)$/i, "$1");
  if (!text || /\b(?:or|but|not|maybe|approximately)\b/i.test(text)) return undefined;
  // Reject prose and ambiguous answers rather than comparing every number.
  if (/^[A-Za-z][A-Za-z'-]*$/.test(text)) return text;
  if (/[\r\n]/.test(text)) return undefined;
  const lexical = text.replace(/\\[A-Za-z]+/g, "").replace(/\s+/g, "");
  if (/[A-Za-z]{2,}/.test(lexical) || /[^\dA-Za-z+\-*/^=.,{}()[\]_%|!°\\]/.test(lexical)) return undefined;
  return text;
}

/** Balanced-brace parser; unlike the AFlow regex, nested fractions remain intact. */
export function extractLastBoxed(text: string): string | undefined {
  return boxedEntries(text).at(-1)?.content;
}

interface BoxedEntry { readonly content: string; readonly start: number; readonly end: number }

function boxedEntries(text: string): readonly BoxedEntry[] {
  const marker = "\\boxed{";
  let cursor = 0;
  const entries: BoxedEntry[] = [];
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
          entries.push({ content: text.slice(contentStart, index).trim(), start, end: index + 1 });
          index++;
          break;
        }
      }
    }
    cursor = Math.max(index, start + marker.length);
  }
  return entries;
}

/** Accept only an explicit trailing list written as separate final boxed values. */
function trailingBoxedList(gold: string, predicted: string): string | undefined {
  const parts = splitTopLevel(predicted);
  if (parts.length < 2) return undefined;
  const entries = boxedEntries(gold);
  if (entries.length < parts.length) return undefined;
  const suffix = entries.slice(-parts.length);
  if (gold.slice(suffix.at(-1)!.end).replace(/[\s$.,;:]+/g, "") !== "") return undefined;
  for (let index = 1; index < suffix.length; index++) {
    const separator = gold.slice(suffix[index - 1]!.end, suffix[index]!.start);
    if (!/(?:\band\b|,)/i.test(separator)) return undefined;
  }
  const expected = suffix.map((item) => item.content);
  return expected.map(normalizeMath).every((item, index) => item === normalizeMath(parts[index]!))
    ? expected.join(",")
    : undefined;
}

function splitTopLevel(value: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let parentheses = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "{") braces++;
    else if (value[index] === "}") braces--;
    else if (value[index] === "(") parentheses++;
    else if (value[index] === ")") parentheses--;
    else if (value[index] === "," && braces === 0 && parentheses === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

export function normalizeMath(value: string): string {
  let result = value.normalize("NFKC").trim();
  result = result.replace(/^\$+|\$+$/g, "");
  result = result.replace(/\\(?:left|right)/g, "");
  result = result.replace(/\\(?:dfrac|tfrac)/g, "\\frac");
  // Standard MATH answers often carry presentation-only units. Keep textual
  // answers, but remove unit wrappers and degree markers before comparison.
  result = result.replace(/\\text\{\s*(?:square\s+)?(?:units?|cents?|degrees?)\s*\}/gi, "");
  result = result.replace(/\^?\\circ|°/g, "");
  result = result.replace(/\\text\{([^{}]*)\}/g, "$1");
  result = result.replace(/\\begin\{pmatrix\}|\\end\{pmatrix\}/g, "");
  result = result.replace(/\\(?:,|!|;|:|quad|qquad)/g, "");
  result = result.replace(/\s+/g, "");
  result = result.replace(/\\sqrt(?!\{)([-+]?\d+(?:\.\d+)?)/g, "\\sqrt{$1}");
  result = result.replace(/\\frac\{([-+]?\d+)\}\{([-+]?\d+)\}/g, "$1/$2");
  result = result.replace(/\\frac([-+]?\d)([-+]?\d)/g, "$1/$2");
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

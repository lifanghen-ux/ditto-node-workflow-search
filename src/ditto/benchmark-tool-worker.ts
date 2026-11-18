import { parentPort, workerData } from "node:worker_threads";

type Request = { id: number; tool: "bounded_arithmetic" | "literal_text_find"; args: Record<string, unknown> };
type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false; kind: "input" | "limit"; message: string };

const delayMs = (workerData as { testDelayMs?: number } | undefined)?.testDelayMs ?? 0;
const crashForTest = (workerData as { testCrash?: boolean } | undefined)?.testCrash === true;

parentPort?.on("message", (request: Request) => {
  if (crashForTest) throw new TypeError('Injected tool implementation fault');
  if (delayMs > 0) {
    const until = Date.now() + delayMs;
    while (Date.now() < until) { /* test-only worker delay */ }
  }
  let response: Response;
  try {
    const value = request.tool === "bounded_arithmetic"
      ? evaluateArithmetic(request.args.expression)
      : findLiteralMatches(request.args.text, request.args.needle);
    response = { id: request.id, ok: true, value };
  } catch (error) {
    if (!(error instanceof ToolInputFault) && !(error instanceof ToolLimitFault)) throw error;
    response = {
      id: request.id,
      ok: false,
      kind: error instanceof ToolLimitFault ? "limit" : "input",
      message: error instanceof Error ? error.message : "Invalid tool input",
    };
  }
  parentPort?.postMessage(response);
});

class ToolLimitFault extends Error {}
class ToolInputFault extends Error {}
type Fraction = { n: bigint; d: bigint };
const MAX_ARITHMETIC_BITS = 16_384;
const MAX_ARITHMETIC_MAGNITUDE = 10n ** 100n;

function evaluateArithmetic(input: unknown): number {
  if (typeof input !== "string" || input.length === 0) throw new ToolInputFault("expression must be a non-empty string");
  if (input.length > 4096) throw new ToolLimitFault("expression exceeds 4096 characters");
  return new ArithmeticParser(input).parse();
}

class ArithmeticParser {
  private nodes = 0;
  private readonly tokens: string[];
  private tokenIndex = 0;

  constructor(source: string) {
    const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/^]/g) ?? [];
    if (tokens.join("") !== source.replace(/\s+/g, "")) throw new ToolInputFault("expression contains unsupported characters");
    if (tokens.length > 256) throw new ToolLimitFault("expression exceeds 256 syntax items");
    for (const token of tokens) {
      if (/\d/.test(token) && token.replace(/\D/g, "").replace(/^0+/, "").length > 32) {
        throw new ToolLimitFault("numeric literal exceeds 32 significant decimal digits");
      }
    }
    this.tokens = tokens;
  }

  parse(): number {
    if (this.tokens.length === 0) throw new ToolInputFault("expression is empty");
    const value = this.additive(0);
    if (this.tokenIndex !== this.tokens.length) throw new ToolInputFault("expression has trailing or invalid syntax");
    return this.toNumber(value);
  }

  private additive(depth: number): Fraction {
    this.guardDepth(depth);
    let value = this.multiplicative(depth + 1);
    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const right = this.multiplicative(depth + 1);
      this.countNode();
      value = this.check(value.n * right.d + (operator === "+" ? right.n : -right.n) * value.d, value.d * right.d);
    }
    return value;
  }

  private multiplicative(depth: number): Fraction {
    this.guardDepth(depth);
    let value = this.unary(depth + 1);
    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.take();
      const right = this.unary(depth + 1);
      if (operator === "/" && right.n === 0n) throw new ToolInputFault("division by zero is not allowed");
      this.countNode();
      value = operator === "*" ? this.check(value.n * right.n, value.d * right.d) : this.check(value.n * right.d, value.d * right.n);
    }
    return value;
  }

  private unary(depth: number): Fraction {
    this.guardDepth(depth);
    if (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const value = this.unary(depth + 1);
      this.countNode();
      return operator === "-" ? this.check(-value.n, value.d) : value;
    }
    return this.power(depth + 1);
  }

  private power(depth: number): Fraction {
    this.guardDepth(depth);
    let value = this.primary(depth + 1);
    if (this.peek() === "^") {
      this.take();
      const exponent = this.unary(depth + 1);
      if (exponent.d !== 1n || exponent.n < -100n || exponent.n > 100n) {
        throw new ToolInputFault("power exponent must be an integer from -100 to 100");
      }
      if (value.n === 0n && exponent.n < 0n) throw new ToolInputFault("zero cannot be raised to a negative power");
      this.countNode();
      const power = exponent.n < 0n ? -exponent.n : exponent.n;
      const bits = Math.max(value.n.toString(2).length, value.d.toString(2).length);
      if ((bits - 1) * Number(power) > MAX_ARITHMETIC_BITS) throw new ToolLimitFault("arithmetic precision exceeds 16384 bits");
      value = exponent.n < 0n ? this.check(value.d ** power, value.n ** power) : this.check(value.n ** power, value.d ** power);
    }
    return value;
  }

  private primary(depth: number): Fraction {
    this.guardDepth(depth);
    const token = this.peek();
    if (token === "(") {
      this.take();
      const value = this.additive(depth + 1);
      if (this.take() !== ")") throw new ToolInputFault("missing closing parenthesis");
      this.countNode();
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new ToolInputFault("expected a decimal number");
    this.take();
    this.countNode();
    const [whole = "0", decimal = ""] = token.split(".");
    return this.check(BigInt((whole || "0") + decimal), 10n ** BigInt(decimal.length));
  }

  /** Keep decimal literals and intermediate results exact; no answer rounding rule. */
  private check(n: bigint, d = 1n): Fraction {
    if (d === 0n) throw new ToolInputFault("division by zero is not allowed");
    if (n === 0n) return { n: 0n, d: 1n };
    if (d < 0n) { n = -n; d = -d; }
    let a = n < 0n ? -n : n, b = d;
    while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
    n /= a; d /= a;
    if ((n < 0n ? -n : n) > d * MAX_ARITHMETIC_MAGNITUDE) throw new ToolLimitFault("intermediate result is non-finite or exceeds 1e100");
    if (Math.max(n.toString(2).length, d.toString(2).length) > MAX_ARITHMETIC_BITS) throw new ToolLimitFault("arithmetic precision exceeds 16384 bits");
    return { n, d };
  }

  /** One final IEEE-754 conversion, including ties-to-even and subnormals. */
  private toNumber({ n, d }: Fraction): number {
    if (n === 0n) return 0;
    const negative = n < 0n;
    if (negative) n = -n;
    let exponent = n.toString(2).length - d.toString(2).length;
    if (exponent >= 0 ? n < (d << BigInt(exponent)) : (n << BigInt(-exponent)) < d) exponent--;
    const shift = exponent < -1022 ? 1074 : 52 - exponent;
    const numerator = shift >= 0 ? n << BigInt(shift) : n;
    const denominator = shift >= 0 ? d : d << BigInt(-shift);
    let significand = numerator / denominator;
    const twiceRemainder = (numerator % denominator) * 2n;
    if (twiceRemainder > denominator || (twiceRemainder === denominator && significand % 2n !== 0n)) significand++;
    const value = Number(significand) * 2 ** -shift;
    return negative ? -value : value;
  }

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > 256) throw new ToolLimitFault("expression exceeds 256 AST nodes");
  }

  private guardDepth(depth: number): void {
    if (depth > 32) throw new ToolLimitFault("expression nesting exceeds depth 32");
  }

  private peek(): string | undefined { return this.tokens[this.tokenIndex]; }
  private take(): string | undefined { return this.tokens[this.tokenIndex++]; }
}

function findLiteralMatches(textValue: unknown, needleValue: unknown): { count: number; truncated: boolean; matches: Array<{ position: number; snippet: string }> } {
  if (typeof textValue !== "string") throw new ToolInputFault("text must be a string");
  if (typeof needleValue !== "string" || needleValue.length === 0) throw new ToolInputFault("needle must be a non-empty string");
  if (textValue.length > 65536) throw new ToolLimitFault("text exceeds 65536 characters");
  if (needleValue.length > 256) throw new ToolLimitFault("needle exceeds 256 characters");
  const matches: Array<{ position: number; snippet: string }> = [];
  let position = 0;
  let truncated = false;
  while (position <= textValue.length - needleValue.length) {
    const found = textValue.indexOf(needleValue, position);
    if (found < 0) break;
    if (matches.length === 100) { truncated = true; break; }
    matches.push({
      position: found,
      snippet: textValue.slice(Math.max(0, found - 64), found + needleValue.length + 64).slice(0, 256),
    });
    position = found + Math.max(needleValue.length, 1);
  }
  return { count: matches.length, truncated, matches };
}

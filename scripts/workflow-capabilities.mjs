/** Shared deterministic capabilities for model-generated A and B candidates.
 * No task-specific answer policy, solver role or workflow is defined here.
 */
export function unwrap(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'output')) {
    if (value.status !== 'success' || value.output === undefined) throw new Error(`Inference failure [${value.error?.code ?? value.status}]: ${value.error?.message ?? 'No output'}`);
    return value.output;
  }
  if (value?.status && value.status !== 'success') throw new Error(`Operation failure [${value.error?.code ?? value.status}]: ${value.error?.message ?? 'No output'}`);
  return value;
}
export function parseJson(value) {
  if (typeof value !== 'string') throw new Error('parseJson requires text');
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
export function answerText(value) {
  if (typeof value !== 'string') throw new Error('The generated workflow must return a string answer');
  return value.trim();
}
export function arithmetic(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('Nonempty expression required');
  const source = expression.trim();
  const tokens = source.match(/\d+(?:\.\d*)?|\.\d+|[()+*/-]/g) ?? [];
  if (tokens.join('') !== source.replace(/\s/g, '')) throw new Error('Only decimal numbers and + - * / ( ) are supported');
  let index = 0;
  function atom() {
    const token = tokens[index++];
    if (token === '-') return -atom();
    if (token === '+') return atom();
    if (token === '(') { const value = sum(); if (tokens[index++] !== ')') throw new Error('Missing closing parenthesis'); return value; }
    if (!token || !/^(?:\d|\.\d)/.test(token)) throw new Error('Number required');
    return Number(token);
  }
  function product() { let value = atom(); while (tokens[index] === '*' || tokens[index] === '/') { const operator = tokens[index++], right = atom(); value = operator === '*' ? value * right : value / right; } return value; }
  function sum() { let value = product(); while (tokens[index] === '+' || tokens[index] === '-') { const operator = tokens[index++], right = product(); value = operator === '+' ? value + right : value - right; } return value; }
  const value = sum();
  if (index !== tokens.length || !Number.isFinite(value)) throw new Error('Invalid or nonfinite arithmetic');
  return { expression, value };
}
export function locateText({ text, query = '', terms = [] }) {
  if (typeof text !== 'string' || typeof query !== 'string' || !Array.isArray(terms) || terms.some(t => typeof t !== 'string')) throw new Error('Invalid public-text query');
  const keys = [...new Set([...terms, ...(query.match(/[\p{L}\p{N}]+/gu) ?? [])].map(t => t.toLowerCase()).filter(Boolean))];
  const segments = text.split(/\n+|(?<=[.!?])\s+/).filter(Boolean).map((content,index) => ({ index, text: content, score: keys.reduce((score,key) => score + Number(content.toLowerCase().includes(key)), 0) }));
  return { segments: segments.filter(s => s.score > 0).sort((a,b) => b.score-a.score || a.index-b.index), note:'Exact lexical retrieval only; a match is not proof of relevance. The original text remains available.' };
}
const tool = (name, description, execute) => ({ name, description, inputSchema: { type:'object' }, effects:['read'], validate(args) { if (!args || typeof args !== 'object') throw new Error('Tool arguments required'); }, async execute(args) { try { const result = execute(args); return { status:'success', content:JSON.stringify(result), structuredContent:result }; } catch(error) { return { status:'failed', error:{ code:'INVALID_ARGUMENTS', message:error.message, retryable:false } }; } } });
export const sharedTools = [
  tool('text_contains', 'Exact substring check in explicitly supplied text. Arguments: text:string, fragment:string, caseSensitive?:boolean. Returns found:boolean,index:number; does not judge relevance.', args => {
    if (typeof args.text !== 'string' || typeof args.fragment !== 'string' || !args.fragment.length) throw new Error('text and nonempty fragment must be strings');
    if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') throw new Error('caseSensitive must be boolean');
    const text = args.caseSensitive === false ? args.text.toLowerCase() : args.text;
    const fragment = args.caseSensitive === false ? args.fragment.toLowerCase() : args.fragment;
    const index = text.indexOf(fragment);
    return { found:index >= 0, index };
  }),
  tool('locate_public_text', 'Lexical retrieval in a supplied public text. Arguments: text:string, query?:string, terms?:string[].', locateText),
  tool('arithmetic', 'Evaluate decimal arithmetic with parentheses and + - * /. Argument: expression:string.', args => arithmetic(args.expression)),
];
export const SHARED_CAPABILITY_GUIDE = `All candidates use native Ditto Workers and the same frozen model/generation. Available tools: locate_public_text({text:string,query?:string,terms?:string[]}) returns {segments:[{index,text,score}],note}; arithmetic({expression:string}) returns {expression,value}, supporting decimal numbers,+,-,*,/,parentheses; text_contains({text:string,fragment:string,caseSensitive?:boolean}) returns {found:boolean,index:number}, an exact substring check, not a relevance judgment. Tools receive only explicit public arguments. There is no hidden answer lookup or private scorer tool. No tool is mandatory. api.unwrap handles Infer envelopes and direct Context/Interaction outputs. api.parseJson(text) parses JSON with optional Markdown fence and throws if invalid. api.answerText(value) requires string and trims surrounding whitespace; it does not solve or normalize the answer. Do not invent helpers or tool APIs.`;

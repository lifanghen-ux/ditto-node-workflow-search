/** Serializable evidence-workflow definitions and their fixed Ditto executor. */
import { SUPPORTED_INFER_TYPES, INFER_INPUT_FIELDS, INFER_CONTRACT_GUIDE, validateGeneratedInferInput } from './generated-infer-contract.mjs';
const INFER_TYPES = new Set(SUPPORTED_INFER_TYPES);
const TYPES = new Set(['CONTEXT.LOAD', ...SUPPORTED_INFER_TYPES, 'INTERACTION.ACT.TOOL', 'INTERACTION.OBSERVE']);
const DEFAULT_TOOLS = ['locate_public_text', 'arithmetic', 'text_contains'];
const OPS = new Set(['literal', 'ref', 'get', 'json', 'parse', 'concat', 'coalesce', 'append']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
export const EVIDENCE_DEFINITION_GUIDE_VERSION = 'generated-b-guide-v4-native-infer';

export const EVIDENCE_DEFINITION_GUIDE = `Return a complete JSON workflow definition, never executable code.
Exact top-level fields: schemaVersion:1, id:string, nodes:Node[], graphs:Graph[], loop:Loop, output:Output.
Node has exactly id, type, graphId, dependencies:string[], inputBindings:object. IDs match [a-z][a-z0-9-]{0,63} and are globally unique. Supported types: CONTEXT.LOAD, INFER.REASONING.SAMPLE, INFER.REASONING.TRAJECTORY, INFER.REASONING.DELIBERATE, INFER.REASONING.REFLECT, INTERACTION.ACT.TOOL, INTERACTION.OBSERVE.
Graph has exactly id and nodeIds:string[]. Every node occurs exactly once in its named Graph; list nodes in local dependency order. dependencies contains only earlier node IDs from the SAME Graph. Independent local nodes may execute concurrently. Cross-Graph data must be referenced explicitly in inputBindings, not inserted into dependencies.
inputBindings is the corresponding Ditto worker input object.
CONTEXT.LOAD input has sources:array. EVERY sources element must evaluate to an OBJECT, never a bare string, number, array or null. The native Worker accepts these exact source forms:
- Message: {role:"system"|"user"|"assistant"|"tool",content:JSONValue,name?:nonempty-string}.
- ContextItem: {id:nonempty-string,content:JSONValue,source?:Reference,metadata?:object}.
- Reference: {uri:nonempty-string,mediaType?:nonempty-string,digest?:nonempty-string}. A Reference points to material; it is not an inline content wrapper.
JSONValue means a string, finite number, boolean, null, array or JSON object. The object itself selects the source form: if id is present it is a ContextItem and MUST also contain content; otherwise if role is present it is a Message and MUST also contain content; otherwise it is a Reference and MUST contain uri. Thus {content:...} without role or id is INVALID, and a bare task.prompt string is INVALID. To load inline public text, bind it to the content field of a Message or ContextItem. An OBSERVE message can be referenced as an entire source object. These are API shapes, not required workflow steps.
The following is the installed native Infer API contract. In B, put its input fields inside inputBindings using the bindings described below. The executor injects model, generation and node metadata; do not include those fields, providers, tools or code. Use json to serialize an object when supplying textual message content. ${INFER_CONTRACT_GUIDE}
TOOL uses call:{id:nonempty-string-expression,name:literal-tool-name,arguments:object-expression}; name must be in the HOST's supplied allowedTools list, and arguments must satisfy that host tool's schema. OBSERVE uses result:reference-to-a-DIRECT-Interaction-output, not an Infer envelope or bare text. Tool argument schemas are supplied separately by the host.
Binding values are JSON constants, recursively evaluated arrays/objects, or an operator object with exactly ONE of these fields:
{literal:JSONValue} preserves literal JSON without interpreting operators;
{ref:["task",...path]} or {ref:["nodes",nodeId,...path]} reads a public task or a normalized node output;
{ref:["prior",nodeId,...path]} in inputBindings reads Loop state before the current Graph invocation, allowing a repeat to inspect its own preceding output; use coalesce for its first visit;
{ref:["state",key,...path]} reads explicitly declared accumulated application state;
{get:{value:Binding,path:(string|nonnegative-integer)[]}} reads properties of a computed value, including array.length, string.length and an indexed string character;
{json:Binding} JSON-stringifies the evaluated value;
{parse:Binding} parses evaluated JSON text;
{concat:Binding[]} concatenates evaluated scalar values;
{coalesce:Binding[]} returns the first available, non-null value, skipping only missing-path errors.
{append:[arrayBinding,valueBinding]} creates an array containing the existing elements followed by ONE new value; it never mutates an input.
Reserved operator keys must occur alone; use literal when a literal object contains one. Paths use own properties only and cannot contain __proto__, prototype or constructor. Public task fields are id, dataset, prompt, outputInstruction. task.prompt ALREADY contains the complete public task, including its passage and question; do not assume that a second hidden question field is provided. Access to labels, credentials, filesystem, environment, code evaluation and external state is unavailable. Same-Graph node references in inputBindings require an explicit local dependency; earlier-Graph references must have executed when read. Coalesce can supply a fallback before a referenced Graph has run.
All node outputs in the nodes namespace are normalized. CONTEXT.LOAD returns {items:[{id,content,source?,metadata?}]}, not a top-level content field. SAMPLE returns {message:{role:"assistant",content:string|MessagePart[]},usage?,...}. TRAJECTORY returns {result:Message,steps:ReasoningStep[],status,stopReason,usage?}; DELIBERATE returns {result:Message,selectedCandidateIds?,assessments?,decisionSummary?,usage?}; REFLECT returns {assessment:{passed?,summary},issues:Issue[],revisedResult?:Message,usage?}. Their native field names differ: read TRAJECTORY/DELIBERATE result.content; read REFLECT assessment.passed or revisedResult.content when available. A REFLECT critique/verify does not promise revisedResult; use coalesce or explicit Loop branching before reading an optional field. TOOL returns {callId,source,status,content?,structuredContent?,error?}. OBSERVE returns {callId,source,status,message:{role:"tool",name?,content:string|MessagePart[]},structuredContent?,error?}; OBSERVE has NO top-level content field. Use the path ["nodes",observeNodeId,"message","content"] for an observation's message content, or ["nodes",observeNodeId,"structuredContent"] for its structured tool data. To load the observation as a Context source, reference ["nodes",observeNodeId,"message"], not its bare content. A text MessagePart is {type:"text",text}; a JSON MessagePart is {type:"json",data}. Infer NodeResult wrappers are removed by the fixed executor. For JSON returned in SAMPLE.message.content, use parse, then get to select its fields.
Loop has entryGraphId:string, transitions:record<graphId,Transition>, optional maxGraphRuns:positive-safe-integer (default Number.MAX_SAFE_INTEGER), optional state:JSON-object of declared initial state values, and optional stateUpdates:record<graphId,record<declaredStateKey,Binding>>. Each task starts with a fresh copy of state. After a Graph finishes, its stateUpdates expressions read its new normalized node outputs and the OLD accumulated state; all assigned keys update simultaneously, before evaluating that Graph's transition. Keys omitted from an update retain their values. State updates may replace values or use append/concat to accumulate them. No other mutable state is exposed. Every Graph must have a transition. Transition is exactly one of:
{kind:"end"}; {kind:"next",graphId};
{kind:"repeat",graphId,maxVisits:positive-safe-integer,until:Condition,nextGraphId?:string};
{kind:"switch",cases:[{when:Condition,graphId}],defaultGraphId?:string}.
Condition is {operator:"truthy"|"falsy",left:Binding} or {operator:"equals"|"not-equals"|"gt"|"gte"|"lt"|"lte",left:Binding,right:Binding}. equals/not-equals use JSON structural equality; gt/gte/lt/lte require finite numeric operands without implicit string conversion. Conditions read the current public task, most recent normalized outputs and updated state. Repeat goes to nextGraphId (or ends) when until is true or the target Graph has reached maxVisits; otherwise it goes to graphId. Switch picks the first true case, then defaultGraphId, or ends if none. maxGraphRuns is the Loop's global Graph-call bound; do not change the frozen model execution settings.
Output has answer:Binding and optional details:Binding. answer must evaluate to a string. It is the final benchmark answer, distinct from optimizer JSON formatting. Return one supported answer, not alternative guesses. The executor returns actual executedNodeIds/executedGraphIds and normalized outputs for trace recording. No node, role, Graph structure or tool use is mandatory; choose the workflow yourself from feedback.`;

function fail(message) { throw new Error(`Invalid evidence workflow: ${message}`); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  return value;
}
function keys(value, allowed, required, label) {
  record(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} has unsupported field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
}
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is not a legal ID`); }
function count(value, label) { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`); }
function allowedToolSet(value = DEFAULT_TOOLS) {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))) throw new Error('Host allowedTools must contain legal tool names');
  return new Set(value);
}
function path(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a path array`);
  for (const part of value) if (!(typeof part === 'string' && !FORBIDDEN_KEYS.has(part)) && !(Number.isSafeInteger(part) && part >= 0)) fail(`${label} contains an unsafe path segment`);
}
function jsonValue(value, label, depth = 0) {
  if (depth > 80) fail(`${label} exceeds binding nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, label, depth + 1); return; }
  record(value, label);
  for (const [key, item] of Object.entries(value)) { if (FORBIDDEN_KEYS.has(key)) fail(`${label} contains a forbidden key`); jsonValue(item, label, depth + 1); }
}
const UNKNOWN_STATIC = Symbol('dynamic binding');
const STRING_STATIC = Symbol('dynamic string');
/** Check binding structure before execution. */
function staticShape(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(staticShape);
  const fields = Object.keys(value), op = fields.length === 1 && OPS.has(fields[0]) ? fields[0] : undefined;
  if (op === 'literal') return value.literal;
  if (op === 'ref') return value.ref[0] === 'task' && value.ref.length === 2 ? STRING_STATIC : UNKNOWN_STATIC;
  if (op === 'json' || op === 'concat') return STRING_STATIC;
  if (op === 'get') {
    let item = staticShape(value.get.value);
    for (const key of value.get.path) {
      if (item === UNKNOWN_STATIC || item === STRING_STATIC || item === null || !['object', 'string'].includes(typeof item) || !Object.hasOwn(item, key)) return UNKNOWN_STATIC;
      item = item[key];
    }
    return item;
  }
  if (op) return UNKNOWN_STATIC;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, staticShape(item)]));
}
function knownObject(value, label) {
  if (value === UNKNOWN_STATIC) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must evaluate to an object`);
  return true;
}
function knownNonemptyString(value, label, trim = false) {
  if (value === UNKNOWN_STATIC || value === STRING_STATIC) return;
  if (typeof value !== 'string' || !(trim ? value.trim() : value).length) fail(`${label} must evaluate to a nonempty string`);
}
function knownString(value, label) {
  if (value === UNKNOWN_STATIC || value === STRING_STATIC) return;
  if (typeof value !== 'string') fail(`${label} must evaluate to a string`);
}
function knownBoolean(value, label) {
  if (value === UNKNOWN_STATIC) return;
  if (typeof value !== 'boolean') fail(`${label} must evaluate to a boolean`);
}
function referenceShape(value, label) {
  if (!knownObject(value, label)) return;
  if (!Object.hasOwn(value, 'uri')) fail(`${label}.uri is required for a Reference; use role+content or id+content for inline text`);
  knownNonemptyString(value.uri, `${label}.uri`);
  for (const field of ['mediaType', 'digest']) if (Object.hasOwn(value, field)) knownNonemptyString(value[field], `${label}.${field}`);
}
function contextSourcesShape(bindingValue, label, resolved = false) {
  const sources = resolved ? bindingValue : staticShape(bindingValue);
  if (sources === UNKNOWN_STATIC) return;
  if (!Array.isArray(sources)) fail(`${label} must evaluate to an array`);
  for (const [index, source] of sources.entries()) {
    const where = `${label}[${index}]`;
    if (!knownObject(source, where)) continue;
    if (Object.hasOwn(source, 'id')) {
      knownNonemptyString(source.id, `${where}.id`);
      if (!Object.hasOwn(source, 'content')) fail(`${where}.content is required for a ContextItem`);
      if (Object.hasOwn(source, 'source')) referenceShape(source.source, `${where}.source`);
      if (Object.hasOwn(source, 'metadata')) knownObject(source.metadata, `${where}.metadata`);
    } else if (Object.hasOwn(source, 'role')) {
      if (source.role !== UNKNOWN_STATIC && source.role !== STRING_STATIC && !['system', 'user', 'assistant', 'tool'].includes(source.role)) fail(`${where}.role must be system, user, assistant or tool`);
      if (!Object.hasOwn(source, 'content')) fail(`${where}.content is required for a Message`);
      if (Object.hasOwn(source, 'name')) knownNonemptyString(source.name, `${where}.name`);
    } else referenceShape(source, where);
    if (resolved) jsonValue(source, where);
  }
}
function messagesShape(bindingValue, label, resolved = false, allowEmpty = false, checkJson = resolved) {
  const messages = resolved ? bindingValue : staticShape(bindingValue);
  if (messages === UNKNOWN_STATIC) return;
  if (!Array.isArray(messages) || (!allowEmpty && !messages.length)) fail(`${label} must evaluate to ${allowEmpty ? 'an array' : 'a nonempty array'}`);
  for (const [index, message] of messages.entries()) {
    const where = `${label}[${index}]`;
    if (!knownObject(message, where)) continue;
    if (!Object.hasOwn(message, 'role')) fail(`${where}.role is required`);
    if (message.role !== UNKNOWN_STATIC && message.role !== STRING_STATIC && !['system', 'user', 'assistant', 'tool'].includes(message.role)) fail(`${where}.role must be system, user, assistant or tool`);
    if (!Object.hasOwn(message, 'content')) fail(`${where}.content is required`);
    if (message.content !== UNKNOWN_STATIC && message.content !== STRING_STATIC && typeof message.content !== 'string' && !Array.isArray(message.content)) fail(`${where}.content must evaluate to a string or MessagePart array; use json for an object`);
    if (Object.hasOwn(message, 'metadata')) knownObject(message.metadata, `${where}.metadata`);
    if (checkJson) jsonValue(message, where);
  }
}
function knownArray(value, label, nonempty = false) {
  if (value === UNKNOWN_STATIC) return false;
  if (!Array.isArray(value) || (nonempty && !value.length)) fail(`${label} must evaluate to ${nonempty ? 'a nonempty array' : 'an array'}`);
  return true;
}
function knownNumber(value, label, minimum = -Infinity, maximum = Infinity, integer = false) {
  if (value === UNKNOWN_STATIC) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) fail(`${label} must evaluate to ${integer ? 'an integer' : 'a finite number'} in range`);
}
function knownChoice(value, choices, label) {
  if (value !== UNKNOWN_STATIC && value !== STRING_STATIC && !choices.includes(value)) fail(`${label} must be one of ${choices.join(', ')}`);
}
function inferItemsShape(value, label, memory = false) {
  if (!knownArray(value, label)) return;
  for (const [index, item] of value.entries()) {
    const where = `${label}[${index}]`;
    if (!knownObject(item, where)) continue;
    if (!Object.hasOwn(item, 'content')) fail(`${where}.content is required`);
    if (memory && !Object.hasOwn(item, 'id')) fail(`${where}.id is required`);
    if (Object.hasOwn(item, 'id')) knownNonemptyString(item.id, `${where}.id`, true);
    if (Object.hasOwn(item, 'source')) knownNonemptyString(item.source, `${where}.source`, true);
    if (Object.hasOwn(item, 'score')) knownNumber(item.score, `${where}.score`);
    if (Object.hasOwn(item, 'timestamp')) knownNumber(item.timestamp, `${where}.timestamp`, 0);
  }
}
function reasoningStepsShape(value, label) {
  if (!knownArray(value, label)) return;
  for (const [index, step] of value.entries()) {
    const where = `${label}[${index}]`;
    if (!knownObject(step, where)) continue;
    for (const key of ['id', 'index', 'type']) if (!Object.hasOwn(step, key)) fail(`${where}.${key} is required`);
    knownNonemptyString(step.id, `${where}.id`, true);
    knownNumber(step.index, `${where}.index`, 0, Number.MAX_SAFE_INTEGER, true);
    knownChoice(step.type, ['plan', 'model', 'decision', 'action_request', 'observation', 'reflection', 'final'], `${where}.type`);
    if (Object.hasOwn(step, 'message')) messagesShape([step.message], `${where}.message`, true, false, false);
  }
}
function containsUnknown(value) {
  if (value === UNKNOWN_STATIC || value === STRING_STATIC) return true;
  return !!value && typeof value === 'object' && Object.values(value).some(containsUnknown);
}
/** Check every statically known portion; native validation checks resolved data. */
function inferInputShape(node, value, resolved = false) {
  const label = `${node.id}.inputBindings`;
  const allowed = INFER_INPUT_FIELDS[node.type].filter(key => !['model', 'generation', 'metadata'].includes(key));
  const required = node.type.endsWith('.SAMPLE') ? ['messages'] : node.type.endsWith('.TRAJECTORY') ? ['messages', 'strategy'] : node.type.endsWith('.DELIBERATE') ? ['candidates'] : ['target', 'mode'];
  keys(value, allowed, required, label);
  const known = resolved ? value : staticShape(value);
  if (Object.hasOwn(known, 'messages')) messagesShape(known.messages, `${node.id}.messages`, true, ['INFER.REASONING.DELIBERATE', 'INFER.REASONING.REFLECT'].includes(node.type), false);
  if (Object.hasOwn(known, 'objective')) knownString(known.objective, `${node.id}.objective`);
  if (Object.hasOwn(known, 'context')) inferItemsShape(known.context, `${node.id}.context`);
  if (Object.hasOwn(known, 'memory')) inferItemsShape(known.memory, `${node.id}.memory`, true);
  if (node.type === 'INFER.REASONING.TRAJECTORY') {
    const strategy = known.strategy;
    if (knownObject(strategy, `${node.id}.strategy`)) {
      if (!Object.hasOwn(strategy, 'name')) fail(`${node.id}.strategy.name is required`);
      knownChoice(strategy.name, ['cot', 'long-cot', 'self-consistency', 'tot', 'got'], `${node.id}.strategy.name`);
      if (Object.hasOwn(strategy, 'options') && knownObject(strategy.options, `${node.id}.strategy.options`)) {
        const ranges = { cot: { rounds: 64 }, 'long-cot': { rounds: 64 }, 'self-consistency': { candidates: 16 }, tot: { breadth: 16, depth: 16, beamWidth: 16 }, got: { breadth: 16, depth: 16 } }[strategy.name];
        if (ranges) for (const [key, maximum] of Object.entries(ranges)) if (Object.hasOwn(strategy.options, key)) knownNumber(strategy.options[key], `${node.id}.strategy.options.${key}`, 1, maximum, true);
      }
    }
    if (Object.hasOwn(known, 'constraints') && knownObject(known.constraints, `${node.id}.constraints`)) {
      keys(known.constraints, ['maxSteps', 'timeoutMs'], [], `${node.id}.constraints`);
      if (Object.hasOwn(known.constraints, 'maxSteps') && known.constraints.maxSteps !== UNKNOWN_STATIC && known.constraints.maxSteps !== Number.MAX_SAFE_INTEGER) fail(`${node.id}.constraints.maxSteps differs from frozen configuration`);
      if (Object.hasOwn(known.constraints, 'timeoutMs')) knownNumber(known.constraints.timeoutMs, `${node.id}.constraints.timeoutMs`, 1, 2 ** 31 - 1, true);
    }
  } else if (node.type === 'INFER.REASONING.DELIBERATE') {
    if (Object.hasOwn(known, 'mode')) knownChoice(known.mode, ['select', 'merge', 'consensus', 'debate'], `${node.id}.mode`);
    const candidates = known.candidates;
    if (knownArray(candidates, `${node.id}.candidates`, true)) {
      const ids = new Set();
      for (const [index, candidate] of candidates.entries()) {
        const where = `${node.id}.candidates[${index}]`;
        if (!knownObject(candidate, where)) continue;
        for (const key of ['id', 'result']) if (!Object.hasOwn(candidate, key)) fail(`${where}.${key} is required`);
        knownNonemptyString(candidate.id, `${where}.id`, true);
        if (typeof candidate.id === 'string') { if (ids.has(candidate.id)) fail(`${node.id}.candidates has a duplicate candidate ID`); ids.add(candidate.id); }
        messagesShape([candidate.result], `${where}.result`, true, false, false);
        if (Object.hasOwn(candidate, 'trajectory')) reasoningStepsShape(candidate.trajectory, `${where}.trajectory`);
        if (Object.hasOwn(candidate, 'score')) knownNumber(candidate.score, `${where}.score`);
      }
    }
    if (Object.hasOwn(known, 'selectCount')) {
      knownNumber(known.selectCount, `${node.id}.selectCount`, 1, Array.isArray(candidates) ? candidates.length : Number.MAX_SAFE_INTEGER, true);
      if (known.mode !== undefined && known.mode !== UNKNOWN_STATIC && known.mode !== STRING_STATIC && known.mode !== 'select') fail(`${node.id}.selectCount requires select mode`);
    }
  } else if (node.type === 'INFER.REASONING.REFLECT') {
    knownChoice(known.mode, ['critique', 'verify', 'revise'], `${node.id}.mode`);
    if (knownObject(known.target, `${node.id}.target`)) {
      if (!['result', 'trajectory', 'artifact'].some(key => Object.hasOwn(known.target, key))) fail(`${node.id}.target requires result, trajectory or artifact`);
      if (Object.hasOwn(known.target, 'result')) messagesShape([known.target.result], `${node.id}.target.result`, true, false, false);
      if (Object.hasOwn(known.target, 'trajectory')) reasoningStepsShape(known.target.trajectory, `${node.id}.target.trajectory`);
    }
    if (Object.hasOwn(known, 'criteria') && knownArray(known.criteria, `${node.id}.criteria`)) {
      const ids = new Set();
      for (const [index, criterion] of known.criteria.entries()) {
        const where = `${node.id}.criteria[${index}]`;
        if (!knownObject(criterion, where)) continue;
        for (const key of ['id', 'description']) { if (!Object.hasOwn(criterion, key)) fail(`${where}.${key} is required`); knownNonemptyString(criterion[key], `${where}.${key}`, true); }
        if (typeof criterion.id === 'string') { if (ids.has(criterion.id)) fail(`${node.id}.criteria has a duplicate criterion ID`); ids.add(criterion.id); }
        if (Object.hasOwn(criterion, 'weight')) knownNumber(criterion.weight, `${where}.weight`, 0);
      }
    }
  }
  // Validate literal inputs with native schemas before constructing the runtime.
  if (!resolved && !containsUnknown(known)) validateGeneratedInferInput(node.type, known, { model: { provider: 'shape-validation', model: 'shape-validation' }, generation: {} });
}
function toolCallShape(bindingValue, label, allowedTools, resolved = false) {
  const call = resolved ? bindingValue : staticShape(bindingValue);
  if (!knownObject(call, label)) return;
  for (const required of ['id', 'name', 'arguments']) if (!Object.hasOwn(call, required)) fail(`${label}.${required} is required`);
  knownNonemptyString(call.id, `${label}.id`, true);
  if (!allowedTools.has(call.name)) fail(`${label} uses an unavailable tool`);
  const args = call.arguments;
  if (!knownObject(args, `${label}.arguments`)) return;
  if (call.name === 'locate_public_text') {
    if (!Object.hasOwn(args, 'text')) fail(`${label}.arguments.text is required`);
    knownString(args.text, `${label}.arguments.text`);
    if (Object.hasOwn(args, 'query')) knownString(args.query, `${label}.arguments.query`);
    if (args.terms !== undefined && args.terms !== UNKNOWN_STATIC) {
      if (!Array.isArray(args.terms)) fail(`${label}.arguments.terms must evaluate to an array`);
      args.terms.forEach((term, index) => knownString(term, `${label}.arguments.terms[${index}]`));
    }
  } else if (call.name === 'arithmetic') {
    if (!Object.hasOwn(args, 'expression')) fail(`${label}.arguments.expression is required`);
    knownNonemptyString(args.expression, `${label}.arguments.expression`, true);
  } else if (call.name === 'text_contains') {
    for (const key of ['text', 'fragment']) { if (!Object.hasOwn(args, key)) fail(`${label}.arguments.${key} is required`); knownString(args[key], `${label}.arguments.${key}`); }
    if (Object.hasOwn(args, 'caseSensitive')) knownBoolean(args.caseSensitive, `${label}.arguments.caseSensitive`);
  }
  if (resolved) jsonValue(call, label);
}
function externalResultShape(bindingValue, label, resolved = false) {
  const result = resolved ? bindingValue : staticShape(bindingValue);
  if (!knownObject(result, label)) return;
  for (const key of ['callId', 'source', 'status']) if (!Object.hasOwn(result, key)) fail(`${label}.${key} is required; OBSERVE expects a DIRECT tool result`);
  knownNonemptyString(result.callId, `${label}.callId`, true);
  knownNonemptyString(result.source, `${label}.source`, true);
  if (result.status !== UNKNOWN_STATIC && result.status !== STRING_STATIC && !['success', 'failed', 'cancelled', 'timeout', 'unknown'].includes(result.status)) fail(`${label}.status is invalid`);
  if (result.status === 'success' && !['content', 'structuredContent', 'references'].some(key => Object.hasOwn(result, key))) fail(`${label} successful result must contain content, structuredContent or references`);
  if (['failed', 'cancelled', 'timeout', 'unknown'].includes(result.status) && !Object.hasOwn(result, 'error')) fail(`${label}.error is required for an unsuccessful result`);
  if (result.error !== undefined && knownObject(result.error, `${label}.error`)) {
    for (const key of ['code', 'message']) { if (!Object.hasOwn(result.error, key)) fail(`${label}.error.${key} is required`); knownNonemptyString(result.error[key], `${label}.error.${key}`, true); }
    if (Object.hasOwn(result.error, 'retryable')) knownBoolean(result.error.retryable, `${label}.error.retryable`);
  }
  if (result.references !== undefined && result.references !== UNKNOWN_STATIC) {
    if (!Array.isArray(result.references)) fail(`${label}.references must evaluate to an array`);
    result.references.forEach((reference, index) => referenceShape(reference, `${label}.references[${index}]`));
  }
  if (resolved) jsonValue(result, label);
}
function validateResolvedInput(node, value, allowedTools) {
  record(value, `${node.id}.input`);
  if (node.type === 'CONTEXT.LOAD') contextSourcesShape(value.sources, `${node.id}.sources`, true);
  else if (INFER_TYPES.has(node.type)) inferInputShape(node, value, true);
  else if (node.type === 'INTERACTION.ACT.TOOL') toolCallShape(value.call, `${node.id}.call`, allowedTools, true);
  else externalResultShape(value.result, `${node.id}.result`, true);
}
function knownOutputPath(parts, context, label) {
  if (['nodes', 'prior'].includes(parts[0]) && parts.length > 2 && context.nodes.get(parts[1])?.type === 'INTERACTION.OBSERVE' && parts[2] === 'content')
    fail(`${label}: OBSERVE has no top-level content; use message.content or structuredContent`);
}
function binding(value, context, label, depth = 0) {
  if (depth > 80) fail(`${label} exceeds binding nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { value.forEach(item => binding(item, context, label, depth + 1)); return; }
  record(value, label);
  const fields = Object.keys(value), reserved = fields.filter(key => OPS.has(key));
  if (!reserved.length) {
    for (const [key, item] of Object.entries(value)) { if (FORBIDDEN_KEYS.has(key)) fail(`${label} contains a forbidden key`); binding(item, context, label, depth + 1); }
    return;
  }
  if (fields.length !== 1) fail(`${label} operator objects require exactly one field`);
  const op = fields[0], operand = value[op];
  if (op === 'literal') { jsonValue(operand, label, depth + 1); return; }
  if (op === 'ref') {
    path(operand, label);
    if (!operand.length || !['task', 'nodes', 'prior', 'state'].includes(operand[0])) fail(`${label} reference root must be task, nodes, prior or state`);
    if (operand[0] === 'task' && operand.length > 1 && !['id', 'dataset', 'prompt', 'outputInstruction'].includes(operand[1])) fail(`${label} cannot access nonpublic task fields`);
    if (operand[0] === 'state' && operand.length > 1 && !context.stateKeys?.has(operand[1])) fail(`${label} references an undeclared state key`);
    if (operand[0] === 'nodes' || operand[0] === 'prior') {
      if (operand.length < 2 || !context.nodes.has(operand[1])) fail(`${label} references an unknown node`);
      const source = context.nodes.get(operand[1]);
      if (operand[0] === 'prior' && !context.node) fail(`${label} prior is available only inside inputBindings`);
      if (operand[0] === 'nodes' && context.node && source.graphId === context.node.graphId && !context.node.dependencies.includes(source.id)) fail(`${label} local reference ${source.id} requires a dependency`);
    }
    knownOutputPath(operand, context, label);
    return;
  }
  if (op === 'get') {
    keys(operand, ['value', 'path'], ['value', 'path'], label);
    binding(operand.value, context, label, depth + 1); path(operand.path, label);
    if (operand.value && typeof operand.value === 'object' && Array.isArray(operand.value.ref)) knownOutputPath([...operand.value.ref, ...operand.path], context, label);
    return;
  }
  if (op === 'concat' || op === 'coalesce' || op === 'append') {
    if (!Array.isArray(operand) || (op === 'coalesce' && !operand.length)) fail(`${label}.${op} must be ${op === 'coalesce' ? 'a nonempty ' : 'an '}array`);
    if (op === 'append' && operand.length !== 2) fail(`${label}.append requires exactly [arrayBinding,valueBinding]`);
    operand.forEach(item => binding(item, context, label, depth + 1)); return;
  }
  binding(operand, context, label, depth + 1);
}
function condition(value, context, label) {
  keys(value, ['operator', 'left', 'right'], ['operator', 'left'], label);
  if (!['equals', 'not-equals', 'truthy', 'falsy', 'gt', 'gte', 'lt', 'lte'].includes(value.operator)) fail(`${label} has an unsupported operator`);
  if (!['truthy', 'falsy'].includes(value.operator)) { if (!Object.hasOwn(value, 'right')) fail(`${label}.right is required`); binding(value.right, context, label); }
  else if (Object.hasOwn(value, 'right')) fail(`${label}.right is not used by this operator`);
  binding(value.left, context, label);
  if (['gt', 'gte', 'lt', 'lte'].includes(value.operator)) for (const operand of [value.left, value.right]) {
    const known = staticShape(operand);
    if (known !== UNKNOWN_STATIC && (typeof known !== 'number' || !Number.isFinite(known))) fail(`${label} numeric comparisons require finite numeric operands without string conversion`);
  }
}

/** Validate a workflow definition. */
export function validateEvidenceDefinition(definition, options = {}) {
  keys(definition, ['schemaVersion', 'id', 'nodes', 'graphs', 'loop', 'output'], ['schemaVersion', 'id', 'nodes', 'graphs', 'loop', 'output'], 'definition');
  if (definition.schemaVersion !== 1) fail('unsupported schemaVersion');
  id(definition.id, 'id');
  if (!Array.isArray(definition.nodes) || !definition.nodes.length) fail('nodes must be a nonempty array');
  if (!Array.isArray(definition.graphs) || !definition.graphs.length) fail('graphs must be a nonempty array');
  record(definition.loop, 'loop');
  const allowedTools = allowedToolSet(options.allowedTools);
  if (definition.loop.state !== undefined) { record(definition.loop.state, 'loop.state'); jsonValue(definition.loop.state, 'loop.state'); }
  const stateKeys = new Set(Object.keys(definition.loop.state ?? {}));
  const nodes = new Map(), graphs = new Map();
  for (const node of definition.nodes) {
    keys(node, ['id', 'type', 'graphId', 'dependencies', 'inputBindings'], ['id', 'type', 'graphId', 'dependencies', 'inputBindings'], 'node');
    id(node.id, 'node.id'); id(node.graphId, 'node.graphId');
    if (nodes.has(node.id) || !TYPES.has(node.type)) fail('duplicate node ID or unsupported node type');
    if (!Array.isArray(node.dependencies) || new Set(node.dependencies).size !== node.dependencies.length) fail(`${node.id}.dependencies must be unique IDs`);
    node.dependencies.forEach(dep => id(dep, `${node.id}.dependency`));
    record(node.inputBindings, `${node.id}.inputBindings`);
    nodes.set(node.id, node);
  }
  const membership = new Set();
  for (const graph of definition.graphs) {
    keys(graph, ['id', 'nodeIds'], ['id', 'nodeIds'], 'graph'); id(graph.id, 'graph.id');
    if (graphs.has(graph.id) || !Array.isArray(graph.nodeIds) || !graph.nodeIds.length) fail('duplicate Graph ID or empty nodeIds');
    const previous = new Set();
    for (const nodeId of graph.nodeIds) {
      const node = nodes.get(nodeId);
      if (!node || node.graphId !== graph.id || membership.has(nodeId)) fail(`invalid Graph membership for ${nodeId}`);
      if (node.dependencies.some(dep => !previous.has(dep))) fail(`${nodeId} dependencies must be earlier nodes in its own Graph`);
      membership.add(nodeId); previous.add(nodeId);
    }
    graphs.set(graph.id, graph);
  }
  if (membership.size !== nodes.size) fail('each node must occur in exactly one Graph');
  for (const node of nodes.values()) {
    binding(node.inputBindings, { nodes, node, stateKeys }, `${node.id}.inputBindings`);
    if (INFER_TYPES.has(node.type)) {
      inferInputShape(node, node.inputBindings);
    } else if (node.type === 'INTERACTION.ACT.TOOL') {
      keys(node.inputBindings, ['call'], ['call'], `${node.id}.inputBindings`);
      keys(node.inputBindings.call, ['id', 'name', 'arguments'], ['id', 'name', 'arguments'], `${node.id}.call`);
      toolCallShape(node.inputBindings.call, `${node.id}.call`, allowedTools);
    } else if (node.type === 'INTERACTION.OBSERVE') {
      keys(node.inputBindings, ['result'], ['result'], `${node.id}.inputBindings`);
      externalResultShape(node.inputBindings.result, `${node.id}.result`);
    }
    else {
      keys(node.inputBindings, ['sources'], ['sources'], `${node.id}.inputBindings`);
      contextSourcesShape(node.inputBindings.sources, `${node.id}.sources`);
    }
  }
  keys(definition.loop, ['entryGraphId', 'transitions', 'maxGraphRuns', 'state', 'stateUpdates'], ['entryGraphId', 'transitions'], 'loop');
  if (!graphs.has(definition.loop.entryGraphId)) fail('unknown entryGraphId');
  if (definition.loop.maxGraphRuns !== undefined) count(definition.loop.maxGraphRuns, 'maxGraphRuns');
  record(definition.loop.transitions, 'loop.transitions');
  if (Object.keys(definition.loop.transitions).length !== graphs.size || Object.keys(definition.loop.transitions).some(key => !graphs.has(key))) fail('every Graph needs exactly one transition');
  const target = graphId => { if (!graphs.has(graphId)) fail(`unknown transition target ${graphId}`); };
  for (const transition of Object.values(definition.loop.transitions)) {
    record(transition, 'transition');
    if (transition.kind === 'end') keys(transition, ['kind'], ['kind'], 'end');
    else if (transition.kind === 'next') { keys(transition, ['kind', 'graphId'], ['kind', 'graphId'], 'next'); target(transition.graphId); }
    else if (transition.kind === 'repeat') {
      keys(transition, ['kind', 'graphId', 'maxVisits', 'until', 'nextGraphId'], ['kind', 'graphId', 'maxVisits', 'until'], 'repeat');
      target(transition.graphId); count(transition.maxVisits, 'maxVisits'); condition(transition.until, { nodes, stateKeys }, 'repeat.until');
      if (transition.nextGraphId !== undefined) target(transition.nextGraphId);
    } else if (transition.kind === 'switch') {
      keys(transition, ['kind', 'cases', 'defaultGraphId'], ['kind', 'cases'], 'switch');
      if (!Array.isArray(transition.cases)) fail('switch.cases must be an array');
      for (const item of transition.cases) { keys(item, ['when', 'graphId'], ['when', 'graphId'], 'switch case'); condition(item.when, { nodes, stateKeys }, 'switch.when'); target(item.graphId); }
      if (transition.defaultGraphId !== undefined) target(transition.defaultGraphId);
    } else fail('unsupported transition kind');
  }
  if (definition.loop.stateUpdates !== undefined) {
    record(definition.loop.stateUpdates, 'loop.stateUpdates');
    for (const [graphId, patch] of Object.entries(definition.loop.stateUpdates)) {
      target(graphId); record(patch, `loop.stateUpdates.${graphId}`);
      for (const [key, value] of Object.entries(patch)) {
        if (!stateKeys.has(key)) fail(`loop.stateUpdates.${graphId} assigns undeclared state key ${key}`);
        binding(value, { nodes, stateKeys }, `loop.stateUpdates.${graphId}.${key}`);
      }
    }
  }
  keys(definition.output, ['answer', 'details'], ['answer'], 'output');
  binding(definition.output.answer, { nodes, stateKeys }, 'output.answer');
  if (Object.hasOwn(definition.output, 'details')) binding(definition.output.details, { nodes, stateKeys }, 'output.details');
  // A detached snapshot prevents caller edits from changing a compiled candidate.
  return structuredClone(definition);
}

class MissingBindingError extends Error {}
function readPath(value, parts) {
  for (const part of parts) {
    if (value === null || !['object', 'string'].includes(typeof value) || !Object.hasOwn(value, part)) throw new MissingBindingError(`Missing explicit binding path: ${parts.join('.')}`);
    value = value[part];
  }
  if (value === undefined) throw new MissingBindingError('Undefined binding value');
  return value;
}
function evaluate(value, environment) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => evaluate(item, environment));
  const op = Object.keys(value).length === 1 ? Object.keys(value)[0] : '';
  if (op === 'literal') return structuredClone(value.literal);
  if (op === 'ref') return readPath(environment, value.ref);
  if (op === 'get') return readPath(evaluate(value.get.value, environment), value.get.path);
  if (op === 'json') return JSON.stringify(evaluate(value.json, environment));
  if (op === 'parse') { const text = evaluate(value.parse, environment); if (typeof text !== 'string') throw new Error('parse requires JSON text'); return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  if (op === 'concat') return value.concat.map(item => { const scalar = evaluate(item, environment); if (scalar !== null && typeof scalar === 'object') throw new Error('concat requires scalars; use json for objects'); return String(scalar ?? ''); }).join('');
  if (op === 'append') { const array = evaluate(value.append[0], environment); if (!Array.isArray(array)) throw new Error('append requires an array as its first operand'); return [...array, evaluate(value.append[1], environment)]; }
  if (op === 'coalesce') {
    for (const item of value.coalesce) {
      try { const resolved = evaluate(item, environment); if (resolved !== null && resolved !== undefined) return resolved; }
      catch (error) { if (!(error instanceof MissingBindingError)) throw error; }
    }
    throw new MissingBindingError('No coalesce binding is available');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item, environment)]));
}
function testCondition(condition, environment) {
  const left = evaluate(condition.left, environment);
  if (condition.operator === 'truthy') return !!left;
  if (condition.operator === 'falsy') return !left;
  const right = evaluate(condition.right, environment);
  if (['gt', 'gte', 'lt', 'lte'].includes(condition.operator)) {
    if (typeof left !== 'number' || !Number.isFinite(left) || typeof right !== 'number' || !Number.isFinite(right)) throw new Error('Numeric conditions require finite numeric operands');
    if (condition.operator === 'gt') return left > right;
    if (condition.operator === 'gte') return left >= right;
    if (condition.operator === 'lt') return left < right;
    return left <= right;
  }
  // JSON structural equality is independent of object property insertion order.
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  const equal = JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  return condition.operator === 'equals' ? equal : !equal;
}
function normalized(value, unwrap) {
  if (value && Object.hasOwn(value, 'output')) return unwrap(value);
  // Failed Interaction results are evidence that can be observed by the graph;
  // a failed Infer NodeResult without output is an execution failure.
  if (value && Object.hasOwn(value, 'status') && !value.callId && !value.message && !value.items) return unwrap(value);
  return value;
}

/** Compile the definition into Graphs and Loop control. */
export function compileEvidenceDefinition(definition, capabilities, options = {}) {
  const spec = validateEvidenceDefinition(definition, { allowedTools: capabilities.allowedTools });
  const { graph, loop, graphStep, model, generation, unwrap } = capabilities;
  for (const [name, fn] of Object.entries({ graph, loop, graphStep, unwrap })) if (typeof fn !== 'function') throw new Error(`Missing host capability: ${name}`);
  if (!model || !generation) throw new Error('Host model and generation are required');
  const allowedTools = allowedToolSet(capabilities.allowedTools);
  if (options.trace !== undefined && !Array.isArray(options.trace)) throw new Error('trace must be an array');
  const trace = options.trace;
  const nodes = new Map(spec.nodes.map(node => [node.id, node]));
  const compiled = new Map();
  for (const group of spec.graphs) {
    let builder = graph(`${spec.id}:${group.id}`);
    for (const nodeId of group.nodeIds) {
      const node = nodes.get(nodeId);
      builder = builder.node(node.id, node.type, node.dependencies, (input, localOutputs) => {
        const event = trace ? { kind: 'node', graphId: group.id, nodeId: node.id, nodeType: node.type, invocation: input.invocation, taskId: input.task.id, input: null } : undefined;
        if (event) { trace.push(event); input.traceEntries.set(node.id, event); }
        try {
          const available = Object.assign(Object.create(null), input.priorOutputs);
          for (const dependency of node.dependencies) available[dependency] = normalized(localOutputs[dependency], unwrap);
          const bound = evaluate(node.inputBindings, { task: input.task, nodes: available, prior: input.priorOutputs, state: input.state });
          const identity = { experiment: 'generated-workflow-b-v1', nodeType: node.type, nodeId: node.id, graphId: group.id, taskId: input.task.id, dataset: input.task.dataset };
          let actual = INFER_TYPES.has(node.type) ? { ...bound, model, generation, metadata: identity } : bound;
          if (event) event.input = structuredClone(actual);
          validateResolvedInput(node, bound, allowedTools);
          if (INFER_TYPES.has(node.type)) {
            actual = validateGeneratedInferInput(node.type, bound, { model, generation }, identity);
            if (event) event.input = structuredClone(actual);
          }
          const gate = capabilities.beforeNode?.({ type: node.type, nodeId: node.id, graphId: group.id, invocation: input.invocation, input: actual });
          if (gate && typeof gate.then === 'function') throw new Error('Host beforeNode must be synchronous and throw to stop execution');
          return actual;
        } catch (error) {
          if (event) event.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      });
    }
    compiled.set(group.id, builder);
  }
  return loop({ id: spec.id, maxIterations: spec.loop.maxGraphRuns ?? Number.MAX_SAFE_INTEGER, *plan(inputTask) {
    const task = Object.freeze({ id: inputTask.id, dataset: inputTask.dataset, prompt: inputTask.prompt, outputInstruction: inputTask.outputInstruction });
    const outputs = Object.create(null), visits = Object.create(null), executedNodeIds = [], executedGraphIds = [];
    const state = structuredClone(spec.loop.state ?? {});
    let invocation = 0;
    let graphId = spec.loop.entryGraphId;
    while (graphId !== undefined) {
      const group = spec.graphs.find(item => item.id === graphId);
      const traceEntries = new Map();
      invocation++;
      let raw;
      try {
        raw = yield* graphStep(compiled.get(graphId), { task, priorOutputs: Object.freeze({ ...outputs }), state: structuredClone(state), invocation, traceEntries });
      } catch (error) {
        for (const event of traceEntries.values()) if (!Object.hasOwn(event, 'output') && !Object.hasOwn(event, 'error')) event.error = `Graph failed before this node output was returned: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
      // Save every raw result before normalization can reject any one envelope.
      if (trace) for (const nodeId of group.nodeIds) if (Object.hasOwn(raw, nodeId) && traceEntries.has(nodeId)) traceEntries.get(nodeId).output = structuredClone(raw[nodeId]);
      executedGraphIds.push(graphId); visits[graphId] = (visits[graphId] ?? 0) + 1;
      for (const nodeId of group.nodeIds) {
        try {
          if (!Object.hasOwn(raw, nodeId)) throw new Error(`Graph omitted output: ${nodeId}`);
          outputs[nodeId] = normalized(raw[nodeId], unwrap); executedNodeIds.push(nodeId);
        } catch (error) { if (traceEntries.has(nodeId)) traceEntries.get(nodeId).error = error instanceof Error ? error.message : String(error); throw error; }
      }
      const updateEnvironment = { task, nodes: outputs, state };
      const patch = Object.fromEntries(Object.entries(spec.loop.stateUpdates?.[graphId] ?? {}).map(([key, value]) => [key, evaluate(value, updateEnvironment)]));
      jsonValue(patch, `loop.stateUpdates.${graphId}`);
      Object.assign(state, structuredClone(patch));
      const transition = spec.loop.transitions[graphId], environment = { task, nodes: outputs, state };
      if (transition.kind === 'end') graphId = undefined;
      else if (transition.kind === 'next') graphId = transition.graphId;
      else if (transition.kind === 'switch') graphId = transition.cases.find(item => testCondition(item.when, environment))?.graphId ?? transition.defaultGraphId;
      else graphId = testCondition(transition.until, environment) || (visits[transition.graphId] ?? 0) >= transition.maxVisits ? transition.nextGraphId : transition.graphId;
    }
    const environment = { task, nodes: outputs, state }, rawAnswer = evaluate(spec.output.answer, environment);
    const answer = typeof capabilities.answerText === 'function' ? capabilities.answerText(rawAnswer) : rawAnswer;
    if (typeof answer !== 'string') throw new Error('Workflow output.answer must evaluate to a string');
    return Object.freeze({ answer, executedNodeIds: Object.freeze(executedNodeIds), executedGraphIds: Object.freeze(executedGraphIds),
      outputs: Object.freeze({ ...outputs }), state: Object.freeze(structuredClone(state)), ...(Object.hasOwn(spec.output, 'details') ? { details: evaluate(spec.output.details, environment) } : {}) });
  } });
}

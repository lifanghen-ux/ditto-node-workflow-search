// Resolve native 0.1.1 schemas from both scripts/ and saved run directories.
const inferEntry = import.meta.resolve('@codesoul-co/ditto/worker/infer');
const native = await Promise.all([
  import(new URL('./reasoning/sample/schema.js', inferEntry)),
  import(new URL('./reasoning/trajectory/schema.js', inferEntry)),
  import(new URL('./reasoning/deliberate/schema.js', inferEntry)),
  import(new URL('./reasoning/reflect/schema.js', inferEntry)),
  import(new URL('./reasoning/trajectory/strategies/cot.js', inferEntry)),
]);
const validators = Object.freeze({
  'INFER.REASONING.SAMPLE': native[0].validateSample,
  'INFER.REASONING.TRAJECTORY': native[1].validateTrajectory,
  'INFER.REASONING.DELIBERATE': native[2].validateDeliberate,
  'INFER.REASONING.REFLECT': native[3].validateReflect,
});
export const SUPPORTED_INFER_TYPES = Object.freeze(Object.keys(validators));
export const INFER_INPUT_FIELDS = Object.freeze(Object.fromEntries(Object.entries({
  'INFER.REASONING.SAMPLE': ['messages','actions','model','generation','metadata'],
  'INFER.REASONING.TRAJECTORY': ['messages','objective','context','memory','strategy','constraints','model','generation','metadata'],
  'INFER.REASONING.DELIBERATE': ['messages','objective','candidates','mode','selectCount','context','model','generation','metadata'],
  'INFER.REASONING.REFLECT': ['messages','target','mode','criteria','context','memory','model','generation','metadata'],
}).map(([type, fields]) => [type, Object.freeze(fields)])));

export const INFER_CONTRACT_GUIDE_VERSION = 'native-infer-0.1.1-frozen-v1';
export const INFER_CONTRACT_GUIDE = String.raw`Native Infer contract (@codesoul-co/ditto 0.1.1; native-infer-0.1.1-frozen-v1):
All four operations below dispatch to the REAL installed Infer Worker. They return a NodeResult ENVELOPE {status:'success',output:{...},...}; a failed/timeout/cancelled envelope may contain error and partial output. Check status before using output. Native operation results below mean the .output field, or api.unwrap(envelope).
Every operation uses frozen api.model and api.generation (in B, the host owns these fields). A may omit them or repeat them exactly. No model/providerOptions/generation overrides. Host metadata.nodeType is the actual dispatched operation for diagnostics and reflection format handling; metadata does not customize the native operation's system prompt.
Message means {role:'system'|'user'|'assistant'|'tool',content:string|unknown[],metadata?:object}. ContextItem means {id?:nonempty-string,content:JSONValue,source?:nonempty-string,score?:finite-number}; MemoryItem means {id:nonempty-string,content:JSONValue,score?:finite-number,timestamp?:nonnegative-number}. Pass item ARRAYS, not a CONTEXT.LOAD envelope. All generated inputs must be JSON data. Native Infer messages accept content arrays; text strings are the portable provider format.

INFER.REASONING.SAMPLE: {messages:nonempty-Message[],actions?:ActionDescriptor[],metadata?:object}. ActionDescriptor is {name:nonempty-string,description?:string,inputSchema:object,target?:{kind:'tool',toolName?:string}|{kind:'mcp',server:string,toolName:string}|{kind:'node',node:string}}. SAMPLE may REQUEST actions; it never executes them. Route action requests explicitly to registered Interaction nodes. Output {message:Message,finishReason,actionRequests?,usage?}. Read .message.content, not .result.

INFER.REASONING.TRAJECTORY: {messages:nonempty-Message[],objective?:string,context?:ContextItem[],memory?:MemoryItem[],strategy:{name,options?:object},constraints?:{maxSteps?:Number.MAX_SAFE_INTEGER,timeoutMs?:positive-integer},metadata?:object}. strategy is an OBJECT, not a string. Native strategies and their options: 'cot' / 'long-cot': {rounds?:1..64 integer}, defaults 2 / 4; 'self-consistency': {candidates?:1..16 integer}, default 3; 'tot': {breadth?:1..16,depth?:1..16,beamWidth?:1..16 integers}, defaults 3,2,2; 'got': {breadth?:1..16,depth?:1..16 integers}, defaults 3,2. Options control native internal model calls. maxSteps is injected as Number.MAX_SAFE_INTEGER and cannot be lowered. timeoutMs accepts 1..2147483647. Native maxTotalTokens is unavailable in this fixed-generation experiment because it rewrites per-call maxTokens. TRAJECTORY never executes actions. Output {result:Message,steps:ReasoningStep[],status:'completed'|'partial'|'failed',stopReason,usage?}. Read .result.content and check status/stopReason. Native ToT calls DELIBERATE internally; GoT merges internally; self-consistency expects the model to emit JSON containing an answer string and fails on a tied vote. Model responses, internal prompts, steps, limits and native errors are preserved.

INFER.REASONING.DELIBERATE: {messages?:Message[],objective?:string,candidates:nonempty-array-of-{id:unique-nonempty-string,result:Message,trajectory?:ReasoningStep[],score?:finite-number},mode?:'select'|'merge'|'consensus'|'debate',selectCount?:positive-integer,context?:ContextItem[],metadata?:object}. Default mode is 'select'. selectCount is allowed only in select mode, from 1 to candidates.length, default 1. Include the original public task in messages when the comparison needs it. Each candidate carries its ACTUAL message, not an Infer envelope or plain answer string. Native output requires structured model JSON {result:Message,selectedCandidateIds?:string[],assessments?:[{candidateId,score?,accepted?,summary?}],decisionSummary?:string}. In select mode the model must name exactly selectCount distinct supplied IDs; the Worker returns the FIRST selected candidate's ORIGINAL message as result, even if the model writes a different result. Other modes return model .result. Worker output {result,selectedCandidateIds?,assessments?,decisionSummary?,usage?}; read .result.content.

INFER.REASONING.REFLECT: {messages?:Message[],target:{result?:Message,trajectory?:ReasoningStep[],artifact?:JSONValue},mode:'critique'|'verify'|'revise',criteria?:[{id:unique-nonempty-string,description:nonempty-string,weight?:nonnegative-number}],context?:ContextItem[],memory?:MemoryItem[],metadata?:object}. target needs at least one of result/trajectory/artifact. criteria are objects, not strings. Include task/output requirements as public messages or criteria; native reflect supplies its own fixed system prompt. Model response must be JSON {assessment:{summary:string,passed?:boolean},issues:[{severity:'info'|'warning'|'error',description:nonempty-string,suggestedFix?:string}],revisedResult?:Message}. verify REQUIRES assessment.passed boolean; revise REQUIRES revisedResult. critique can report issues without a revised answer. Output {assessment,issues,revisedResult?,usage?}; .revisedResult.content exists only when returned. Neither .result nor .message is the reflection output. Select any returned revisedResult explicitly in your workflow; a reflection does not automatically change application state.

ReasoningStep means {id:nonempty-string,index:nonnegative-safe-integer,type:'plan'|'model'|'decision'|'action_request'|'observation'|'reflection'|'final',parentIds?:string[],summary?:string,message?:Message,actionRequest?:object,observation?:object}. Reuse real public TRAJECTORY steps where appropriate. All node choice, objectives, prompts, candidates, criteria, state updates and routing remain model-authored; this guide specifies interfaces rather than a workflow strategy.`;

function fail(message) { throw new Error(`Generated Infer validation: ${message}`); }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value; }
function same(a,b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function assertJson(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object') fail(`${path} must contain only JSON data`);
  if (seen.has(value)) fail(`${path} must not contain a cycle`);
  seen.add(value);
  for (const [key,child] of Object.entries(value)) {
    // Undefined optional object properties have the same meaning as omission.
    if (child === undefined && !Array.isArray(value)) continue;
    assertJson(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

/** Validate data immediately before native dispatch, then cross VM boundaries as JSON. */
export function validateGeneratedInferInput(type, input, capabilities, identity = {}) {
  const validate = Object.hasOwn(validators,type) ? validators[type] : undefined;
  if (!validate) fail(`unsupported operation ${type}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${type} input must be an object`);
  if (!capabilities?.model || !capabilities?.generation) fail('frozen model and generation are required');
  const label = type.split('.').at(-1);
  for (const key of Object.keys(input)) if (!INFER_INPUT_FIELDS[type].includes(key)) fail(`${label} input.${key} is not a published input field`);
  assertJson(input, `${label} input`);
  if (input.model !== undefined && !same(input.model,capabilities.model)) fail(`${label} model differs from frozen configuration`);
  if (input.generation !== undefined && !same(input.generation,capabilities.generation)) fail(`${label} generation differs from frozen configuration`);
  const prepared = { ...input, model:capabilities.model, generation:capabilities.generation };
  if (type === 'INFER.REASONING.TRAJECTORY') {
    if (input.constraints !== undefined && (!input.constraints || typeof input.constraints !== 'object' || Array.isArray(input.constraints))) fail('TRAJECTORY constraints must be an object');
    if (input.constraints?.maxSteps !== undefined && input.constraints.maxSteps !== Number.MAX_SAFE_INTEGER) fail('TRAJECTORY maxSteps differs from frozen configuration');
    if (input.constraints?.maxTotalTokens !== undefined) fail('TRAJECTORY maxTotalTokens would override frozen generation.maxTokens');
    prepared.constraints = {...input.constraints,maxSteps:Number.MAX_SAFE_INTEGER};
  }
  try {
    // The native Deliberate node fills defaults before its schema validator.
    validate(type === 'INFER.REASONING.DELIBERATE' && prepared.mode === undefined ? {...prepared,mode:'select'} : prepared);
    if (type === 'INFER.REASONING.TRAJECTORY') {
      const strategy = prepared.strategy;
      const options = strategy.options ?? {};
      const shapes = {
        cot:{rounds:[2,64]},'long-cot':{rounds:[4,64]},
        'self-consistency':{candidates:[3,16]},tot:{breadth:[3,16],depth:[2,16],beamWidth:[2,16]},got:{breadth:[3,16],depth:[2,16]},
      };
      const shape = Object.hasOwn(shapes,strategy.name) ? shapes[strategy.name] : undefined;
      if (!shape) fail(`TRAJECTORY unknown native strategy ${strategy.name}`);
      for (const [key,[fallback,max]] of Object.entries(shape)) native[4].option(options[key],fallback,key,max);
    }
  } catch(error) {
    if (error.message?.startsWith('Generated Infer validation:')) throw error;
    fail(`${label}: ${error.message}`);
  }
  // Validate metadata before attaching diagnostic fields.
  prepared.metadata = {...input.metadata,...identity,nodeType:type};
  return JSON.parse(JSON.stringify(prepared));
}

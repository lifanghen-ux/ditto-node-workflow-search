import { createHash } from 'node:crypto';
import vm from 'node:vm';
import * as ts from 'typescript/unstable/ast';
import { SUPPORTED_INFER_TYPES, INFER_CONTRACT_GUIDE, validateGeneratedInferInput } from './generated-infer-contract.mjs';

const ALLOWED_NODES = new Set(['CONTEXT.LOAD', 'INTERACTION.ACT.TOOL', 'INTERACTION.OBSERVE', ...SUPPORTED_INFER_TYPES]);
const DEFAULT_TOOLS = ['locate_public_text', 'arithmetic'];
const FORBIDDEN = new Set(['process', 'require', 'module', 'exports', 'global', 'globalThis', 'window', 'self', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'SharedWorker', 'WebAssembly', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'Reflect', 'Proxy', 'constructor', '__proto__', 'prototype', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Buffer', 'Deno', 'Bun']);
const CAPABILITY_NAMES = new Set(['graph', 'graphStep', 'loop', 'model', 'generation', 'unwrap', 'parseJson', 'answerText']);

export const GENERATED_A_GUIDE_VERSION = 'generated-workflow-a-v3-native-infer-input-shapes-and-trace';
export const GENERATED_A_GUIDE = String.raw`A output source contract (generated-workflow-a-v3-native-infer-input-shapes-and-trace):
Return JavaScript module source, not TypeScript. It must contain exactly one default export:
export default function createWorkflow(api) { /* create your Graphs and Loop here */ return { definition, outputNodeId, id }; }
The source may declare ordinary helper functions and constants. Imports, require, host filesystem/network/process access, dynamic code generation and prototype reflection are unavailable. This loader performs engineering validation; VM/AST checking is not an operating-system security sandbox.

api contains only graph, graphStep, loop, model, generation, unwrap, parseJson, answerText.
- api.graph(id) returns an immutable native Ditto Graph. g.node(id,type,dependencies,bind) returns a NEW Graph; assign or chain it. Build every Graph during createWorkflow. Node IDs are globally unique in the module. dependencies are earlier IDs in the SAME Graph. bind(input,localOutputs) receives the Graph input and only declared local dependencies. Pass values between Graphs explicitly in your Loop's graphStep inputs.
- api.graphStep(g,input) is a generator. Within the Loop plan use: const outputs = yield* api.graphStep(g,input). outputs maps node IDs to Worker outputs, NOT to a GraphResult envelope.
- api.loop({id,maxIterations:Number.MAX_SAFE_INTEGER,*plan(task){...}}) creates a native Loop. You own its Graph order, branching, repeat logic and public application state. Do not impose a lower maxIterations. Return {answer:string,...optional public details} from the plan. The final answer is passed unchanged except whitespace trimming. api.answerText(value) requires a string and trims it; it performs no task-specific answer correction.
- api.model and api.generation are frozen application configuration. Any Infer input may omit them, in which case the loader injects them. If supplied they must match exactly; do not modify model/generation. Do not supply providerOptions or call a model SDK yourself. TRAJECTORY maxSteps is also frozen at Number.MAX_SAFE_INTEGER.
- api.parseJson(text) parses strict JSON text (a surrounding Markdown JSON fence may be accepted). It does NOT extract an answer from arbitrary prose. api.unwrap(value) accepts the output shapes described below and throws for unsuccessful operations.

Supported real Ditto nodes and input/output shapes:
CONTEXT.LOAD input {sources:[{role:'user',content:string}|{id:string,content:JSONValue,metadata?:object}]} -> DIRECT output {items:[{id,content,source?,metadata?}]}. Use api.unwrap(outputs.loaded) or outputs.loaded; there is no .output wrapper.
INTERACTION.ACT.TOOL input {call:{id:string,name:registeredToolName,arguments:object}} -> DIRECT output {callId,source,status:'success'|'failed'|...,content?,structuredContent?,error?}. api.unwrap checks status then returns the direct result. Available names and signatures are defined by the shared capability guide; do not assume an undeclared tool exists. Examples of individual signatures, when registered:
  locate_public_text arguments {text:string,query?:string,terms?:string[]} -> structuredContent {segments:[{index,text,score}],note}. It searches the supplied public text only. It is a retrieval hint, not a correctness oracle.
  arithmetic arguments {expression:string} -> structuredContent {value,expression}. It computes supported arithmetic; it does not validate operand selection against the task.
  text_contains arguments {text:string,fragment:nonempty-string,caseSensitive?:boolean} -> structuredContent {found:boolean,index:number}. It checks supplied public text only; caseSensitive defaults to true.
INTERACTION.OBSERVE input {result:the DIRECT ExternalResult from TOOL} -> DIRECT output {callId,source,status,message:{role:'tool',name?,content:string|MessagePart[]},structuredContent?,error?}. MessagePart text is {type:'text',text}; JSON is {type:'json',data}. You may use structuredContent directly, JSON.stringify it, or load its message via CONTEXT.LOAD.
${INFER_CONTRACT_GUIDE}

All task material comes from plan(task). Its public fields are id:string, dataset:string, prompt:string, outputInstruction:string, metadata:object. For DROP, task.prompt ALREADY contains the complete passage and question; there are no separate task.passage or task.question fields to concatenate. outputInstruction can be empty. Do not fabricate missing fields or duplicate a passage/question by guessing task structure. No reference answers/private tests are available. Do not embed benchmark-specific solution constants. Return one supported final answer rather than alternative guesses. The individual API signatures above explain interfaces, not a prescribed workflow or solution strategy: you choose all nodes, prompts, intermediate formats, bindings and control logic.

Inputs are shape-checked before Workers run. Infer inputs use the installed native validators described above. CONTEXT.LOAD needs a sources array of Message, ContextItem or Reference objects, not bare strings or bare content values. OBSERVE needs the DIRECT ExternalResult, not an Infer envelope or a message alone. TOOL arguments must match the registered tool signature. Checked inputs are copied to ordinary JSON objects for the native Workers. The loader records actual .node calls, each checked node input and each raw node output with a Graph invocation number; errors are recorded as evidence, not successful observations. Return outputNodeId matching a real created node. Do not invent a plan description to substitute for actual Graph creation.`;

function fail(message) { throw new Error(`Generated A validation: ${message}`); }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value; }
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function plainCopy(value) { return JSON.parse(JSON.stringify(value)); }
function defaultAnswerText(value) { if (typeof value !== 'string') fail('Loop answer must be a string'); return value.trim(); }
function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`); return value; }
function string(value, path, nonempty = false) { if (typeof value !== 'string' || (nonempty && !value.trim())) fail(`${path} must be ${nonempty ? 'a nonempty' : 'a'} string`); }
function json(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail(`${path} must contain only JSON values`);
  if (seen.has(value)) fail(`${path} must not contain a cycle`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) json(child, `${path}.${key}`, seen);
  seen.delete(value);
}
function reference(value, path) {
  object(value, path); string(value.uri, `${path}.uri`, true);
  for (const field of ['mediaType','digest']) if (value[field] !== undefined) string(value[field], `${path}.${field}`, true);
}
function messageContent(value, path, infer = false) {
  if (value === undefined) fail(`${path} is required`);
  if (!infer) { json(value, path); return; }
  if (typeof value === 'string') return;
  if (!Array.isArray(value)) fail(`${path} must be a string or MessagePart array; use JSON.stringify for structured JSON`);
  for (const [index, part] of value.entries()) {
    const p = `${path}[${index}]`; object(part, p);
    if (part.type === 'text') string(part.text, `${p}.text`);
    else if (part.type === 'json') json(part.data, `${p}.data`);
    else if (part.type === 'reference') reference(part.reference, `${p}.reference`);
    else fail(`${p}.type must be text, json or reference`);
  }
}
function message(value, path, infer = false) {
  object(value, path);
  if (!['system','user','assistant','tool'].includes(value.role)) fail(`${path}.role must be system, user, assistant or tool`);
  messageContent(value.content, `${path}.content`, infer);
  if (value.name !== undefined) string(value.name, `${path}.name`, true);
  if (value.metadata !== undefined) { object(value.metadata, `${path}.metadata`); json(value.metadata, `${path}.metadata`); }
}
function errorSnapshot(error) {
  if (error && typeof error === 'object') return { name:typeof error.name==='string'?error.name:'Error', message:typeof error.message==='string'?error.message:String(error), ...(typeof error.code==='string'||typeof error.code==='number'?{code:error.code}:{}) };
  return {name:'Error',message:String(error)};
}
function traceSnapshot(value) {
  const parents = new Set();
  function visit(item) {
    if (item === undefined) return {$type:'undefined'};
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item)?item:{$type:'nonfinite',value:String(item)};
    if (typeof item === 'bigint' || typeof item === 'symbol' || typeof item === 'function') return {$type:typeof item,value:String(item)};
    if (parents.has(item)) return {$type:'circular'};
    parents.add(item);
    const copy = Array.isArray(item)?item.map(visit):Object.fromEntries(Object.entries(item).map(([key,child])=>[key,visit(child)]));
    parents.delete(item); return copy;
  }
  try { return visit(value); } catch(error) { return {$type:'snapshot-error',error:errorSnapshot(error)}; }
}

/** Validate generated source before construction; this is not a security sandbox. */
export function validateGeneratedWorkflowSource(source) {
  if (typeof source !== 'string' || !source.trim()) fail('source must be nonempty text');
  const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  const templates = [];
  while (true) {
    let kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFile) break;
    if (kind === ts.SyntaxKind.OpenBraceToken && templates.length) templates.at(-1).braces++;
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.length) {
      if (templates.at(-1).braces === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
      } else templates.at(-1).braces--;
    }
    if (kind === ts.SyntaxKind.TemplateHead) templates.push({braces:0});
    tokens.push({kind,text:scanner.getTokenText(),value:ts.tokenIsIdentifierOrKeyword(kind) && kind !== ts.SyntaxKind.Identifier ? scanner.getTokenText() : scanner.getTokenValue(),start:scanner.getTokenStart(),end:scanner.getTokenEnd()});
  }
  const exportEdits = [];
  let foundEntry = false;
  for (let i=0;i<tokens.length;i++) {
    const token=tokens[i];
    if (token.kind === ts.SyntaxKind.ImportKeyword) fail('imports are unavailable');
    if (ts.tokenIsIdentifierOrKeyword(token.kind) && FORBIDDEN.has(token.value)) fail(`unavailable identifier ${token.value}`);
    if ((token.kind === ts.SyntaxKind.StringLiteral || token.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) && FORBIDDEN.has(token.value)) fail(`unavailable property ${token.value}`);
    if (token.value === 'api' && token.kind === ts.SyntaxKind.Identifier) {
      if (tokens[i+1]?.kind === ts.SyntaxKind.OpenBracketToken) fail('use named api capabilities, not computed api access');
      if (tokens[i+1]?.kind === ts.SyntaxKind.DotToken && !CAPABILITY_NAMES.has(tokens[i+2]?.value)) fail(`unknown API capability ${tokens[i+2]?.value}`);
    }
    if (token.kind === ts.SyntaxKind.ExportKeyword) {
      if (foundEntry || tokens[i+1]?.kind !== ts.SyntaxKind.DefaultKeyword || tokens[i+2]?.kind !== ts.SyntaxKind.FunctionKeyword || tokens[i+3]?.value !== 'createWorkflow') fail('only export default function createWorkflow(api) is supported');
      if (tokens[i+4]?.kind !== ts.SyntaxKind.OpenParenToken || tokens[i+5]?.value !== 'api' || tokens[i+6]?.kind !== ts.SyntaxKind.CloseParenToken) fail('entry must be createWorkflow(api)');
      foundEntry=true;
      exportEdits.push([token.start,token.end],[tokens[i+1].start,tokens[i+1].end]);
    }
  }
  if (!foundEntry) fail('missing export default function createWorkflow(api)');
  let executable = source;
  for (const [start, end] of exportEdits.sort((a,b) => b[0]-a[0])) executable = executable.slice(0,start) + ' '.repeat(end-start) + executable.slice(end);
  new vm.Script(`\"use strict\";\n${executable}\n;createWorkflow;`, {filename:'generated-workflow-a.mjs'});
  return { executable, sourceHash: createHash('sha256').update(source).digest('hex') };
}

/** Construct a model-authored A module against the same public capability set as B. */
export function compileGeneratedWorkflowA(source, capabilities, options = {}) {
  const { executable, sourceHash } = validateGeneratedWorkflowSource(source);
  for (const name of ['graph','graphStep','loop','unwrap','parseJson']) if (typeof capabilities?.[name] !== 'function') fail(`missing capability ${name}`);
  if (!capabilities.model || !capabilities.generation) fail('frozen model and generation are required');
  const model = Object.freeze(plainCopy(capabilities.model));
  const generation = Object.freeze(plainCopy(capabilities.generation));
  const allowedTools = new Set(capabilities.allowedTools ?? DEFAULT_TOOLS);
  const realByProxy = new WeakMap();
  const graphs = new Map();
  const binderSources = new Map();
  const originalBinders = new Map();
  const createdLoops = new WeakSet();
  const trace = [];
  let invocationCount = 0;
  let constructing = true;

  function checkInput(type, input, identity = {}) {
    object(input, `${type} input`);
    if (SUPPORTED_INFER_TYPES.includes(type)) return validateGeneratedInferInput(type,input,{model,generation},identity);
    if (type === 'CONTEXT.LOAD') {
      if (!Array.isArray(input.sources)) fail('LOAD input.sources must be an array of Message, ContextItem or Reference objects');
      input.sources.forEach((source,index)=>{
        const path=`LOAD input.sources[${index}]`; object(source,path);
        if (Object.hasOwn(source,'id')) {
          string(source.id, `${path}.id`, true); messageContent(source.content, `${path}.content`);
          if (source.source !== undefined) reference(source.source,`${path}.source`);
          if (source.metadata !== undefined) { object(source.metadata,`${path}.metadata`); json(source.metadata,`${path}.metadata`); }
        } else if (Object.hasOwn(source,'role')) message(source,path);
        else reference(source,path);
      });
      if (input.resolveReferences !== undefined && typeof input.resolveReferences !== 'boolean') fail('LOAD input.resolveReferences must be boolean');
    }
    if (type === 'INTERACTION.OBSERVE') {
      const result=object(input.result,'OBSERVE input.result (DIRECT ExternalResult)');
      string(result.callId,'OBSERVE input.result.callId',true); string(result.source,'OBSERVE input.result.source',true);
      if (!['success','failed','cancelled','timeout','unknown'].includes(result.status)) fail('OBSERVE input.result.status is invalid');
      if (result.status==='success' && result.content===undefined && result.structuredContent===undefined && result.references===undefined) fail('OBSERVE successful result needs content, structuredContent or references');
      for (const field of ['content','structuredContent','metadata']) if (result[field]!==undefined) json(result[field],`OBSERVE input.result.${field}`);
      if (result.references!==undefined) {
        if (!Array.isArray(result.references)) fail('OBSERVE input.result.references must be an array');
        result.references.forEach((value,index)=>reference(value,`OBSERVE input.result.references[${index}]`));
      }
      if (result.status!=='success' || result.error!==undefined) {
        object(result.error,'OBSERVE input.result.error'); string(result.error.code,'OBSERVE input.result.error.code',true); string(result.error.message,'OBSERVE input.result.error.message',true);
        if (result.error.retryable!==undefined && typeof result.error.retryable!=='boolean') fail('OBSERVE input.result.error.retryable must be boolean');
      }
    }
    if (type === 'INTERACTION.ACT.TOOL') {
      const call=object(input.call,'TOOL input.call');
      string(call.id,'TOOL input.call.id',true);
      if (!allowedTools.has(call.name)) fail('tool is outside the common capability set');
      const args=object(call.arguments,'TOOL input.call.arguments'); json(args,'TOOL input.call.arguments');
      if (call.name==='locate_public_text') {
        string(args.text,'TOOL locate_public_text.arguments.text');
        if (args.query!==undefined) string(args.query,'TOOL locate_public_text.arguments.query');
        if (args.terms!==undefined && (!Array.isArray(args.terms)||args.terms.some(value=>typeof value!=='string'))) fail('TOOL locate_public_text.arguments.terms must be a string array');
      } else if (call.name==='arithmetic') string(args.expression,'TOOL arithmetic.arguments.expression',true);
      else if (call.name==='text_contains') {
        string(args.text,'TOOL text_contains.arguments.text'); string(args.fragment,'TOOL text_contains.arguments.fragment',true);
        if (args.caseSensitive!==undefined && typeof args.caseSensitive!=='boolean') fail('TOOL text_contains.arguments.caseSensitive must be boolean');
      }
    }
    json(input,`${type} input`);
    return plainCopy(input);
  }
  function wrapGraph(real) {
    graphs.set(real.id, real);
    const proxy = new Proxy(real, { get(target, property) {
      if (property === 'node') return (id, type, dependencies, bind) => {
        if (!constructing) fail('create all Graphs during createWorkflow');
        if (!ALLOWED_NODES.has(type)) fail(`unsupported node ${type}`);
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail('invalid node ID');
        if (typeof bind !== 'function' || !Array.isArray(dependencies)) fail('node requires dependencies and binding function');
        const current = new Set(target.tasks.map(task => task.id));
        if (dependencies.some(dep => !current.has(dep))) fail('local dependencies must reference earlier nodes in the same Graph');
        binderSources.set(`${target.id}:${id}`,String(bind));
        originalBinders.set(`${target.id}:${id}`,bind);
        return wrapGraph(target.node(id, type, dependencies, (input, outputs) => {
          return checkInput(type, bind(input, outputs), {nodeId:id,graphId:target.id});
        }));
      };
      return Reflect.get(target, property, target);
    } });
    realByProxy.set(proxy, real);
    return proxy;
  }
  const api = Object.freeze({
    graph(id) { if (!constructing) fail('create all Graphs during createWorkflow'); if (typeof id !== 'string' || !id.trim()) fail('Graph ID is required'); if (graphs.has(id)) fail(`duplicate Graph ID ${id}`); return wrapGraph(capabilities.graph(id)); },
    *graphStep(candidate, input) {
      const real = realByProxy.get(candidate);
      if (!real || graphs.get(real.id) !== real) fail('graphStep must use the latest created Graph version');
      const invocation=++invocationCount;
      const boundRecords=new Map();
      trace.push({ kind:'graph-start', graphId:real.id, invocation, nodeIds:real.tasks.map(task=>task.id), input:traceSnapshot(input) });
      // Each invocation gets the identical native DAG with invocation-local
      // tracing closures. Repeated/concurrent runs cannot misattribute binds.
      let invocationGraph=capabilities.graph(real.id);
      for (const task of real.tasks) invocationGraph=invocationGraph.node(task.id,task.node,task.dependencies,(graphInput,outputs)=>{
        const record={kind:'node',graphId:real.id,nodeId:task.id,nodeType:task.node,invocation,input:null};
        trace.push(record); boundRecords.set(task.id,record);
        let attemptedInput;
        try {
          attemptedInput=originalBinders.get(`${real.id}:${task.id}`)(graphInput,outputs);
          const checked=checkInput(task.node,attemptedInput,{nodeId:task.id,graphId:real.id,invocation});
          record.input=traceSnapshot(checked);
          capabilities.beforeNode?.({type:task.node,nodeId:task.id,graphId:real.id,invocation,input:checked});
          return checked;
        } catch(error) {
          if (record.input===null && attemptedInput!==undefined) record.input=traceSnapshot(attemptedInput);
          record.error=errorSnapshot(error); throw error;
        }
      });
      try {
        const result = yield* capabilities.graphStep(invocationGraph, input);
        for (const task of real.tasks) if (Object.hasOwn(result,task.id)) {
          const record=boundRecords.get(task.id)??{kind:'node',graphId:real.id,nodeId:task.id,nodeType:task.node,invocation,input:null};
          if (!boundRecords.has(task.id)) trace.push(record);
          record.output=traceSnapshot(result[task.id]);
          if (result[task.id]?.status && result[task.id].status!=='success') record.error=traceSnapshot(result[task.id].error??{message:`Worker status ${result[task.id].status}`});
        }
        trace.push({kind:'graph-complete',graphId:real.id,invocation}); return result;
      }
      catch (error) { trace.push({kind:'graph-failed',graphId:real.id,invocation,error:errorSnapshot(error)}); throw error; }
    },
    loop(value) {
      if (!constructing || !value || typeof value.plan !== 'function') fail('create a generator-based native Loop during createWorkflow');
      if (value.maxIterations !== undefined && value.maxIterations !== Number.MAX_SAFE_INTEGER) fail('maxIterations must match the frozen execution profile');
      const result = capabilities.loop({ ...value, maxIterations:Number.MAX_SAFE_INTEGER });
      createdLoops.add(result);
      return result;
    },
    model, generation,
    unwrap: capabilities.unwrap,
    parseJson: capabilities.parseJson,
    answerText: capabilities.answerText ?? defaultAnswerText,
  });
  const context = vm.createContext(Object.create(null), { name:'generated-workflow-a', codeGeneration:{strings:false,wasm:false} });
  context.api = api;
  const script = new vm.Script(`"use strict";\n${executable}\n;createWorkflow(api);`, {filename:'generated-workflow-a.mjs'});
  const created = script.runInContext(context, {timeout:options.factoryTimeoutMs ?? 2000});
  constructing = false;
  if (!created || typeof created !== 'object' || !createdLoops.has(created.definition)) fail('entry must return {definition} created by api.loop');
  if (!graphs.size || [...graphs.values()].some(g=>g.tasks.length===0)) fail('workflow must have nonempty Graphs');
  const nodes = [...graphs.values()].flatMap(g=>g.tasks.map(task=>({ id:task.id,type:task.node,graphId:g.id,dependencies:[...task.dependencies],config:{bindingSource:binderSources.get(`${g.id}:${task.id}`)} })));
  if (new Set(nodes.map(node=>node.id)).size !== nodes.length) fail('node IDs must be globally unique');
  if (typeof created.outputNodeId !== 'string' || !nodes.some(node=>node.id===created.outputNodeId)) fail('outputNodeId must name a created node');
  const recordedGraphs = [...graphs.values()].map(g=>({id:g.id,nodeIds:g.tasks.map(task=>task.id)}));
  if (created.plan) {
    const claimed = plainCopy(created.plan);
    if (!Array.isArray(claimed.nodes) || !Array.isArray(claimed.graphs)) fail('optional plan must list nodes and Graphs');
    const identity = n=>({id:n.id,type:n.type,graphId:n.graphId,dependencies:n.dependencies});
    if (!same(claimed.nodes.map(identity),nodes.map(identity)) || !same(claimed.graphs,recordedGraphs)) fail('claimed plan differs from actual Graph construction');
  }
  const native = created.definition;
  const definition = capabilities.loop({ ...native, *plan(task) {
    const result = yield* native.plan(task);
    if (!result || typeof result !== 'object') fail('Loop must return {answer:string}');
    return {...result,answer:api.answerText(result.answer)};
  } });
  const plan = {
    id:typeof created.id==='string'?created.id:native.id,
    nodes,graphs:recordedGraphs,
    loop:{control:'generated-code',transitions:{},maxGraphRuns:Number.MAX_SAFE_INTEGER},
    outputNodeId:created.outputNodeId,
  };
  return {definition,plan,sourceHash,trace};
}

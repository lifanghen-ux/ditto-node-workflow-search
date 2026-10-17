import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { graph, graphStep, loop, type DittoRuntime } from '@codesoul-co/ditto/runtime';
import type { Context, ContextItem, ExternalResult, Observation, ToolCall } from '@codesoul-co/ditto/contracts';
import type { Message, ModelConfig, SampleOutput, Usage } from '@codesoul-co/ditto/worker/infer';
import type { AgentPlanSpec, AgentRunResult, BenchmarkTask, GraphTransition, OutputCondition } from '../domain.js';
import { automationScope } from '../benchmark/automation.js';
import { captureProviderDiagnostics, summarizeProviderDiagnostics } from '../ditto/provider-diagnostics.js';
import { captureModelOutputs, OutputBudgetAnswerError, type ModelOutputRecord } from "../ditto/output-limit.js";
import { WorkflowExecutionError } from './executor.js';
import { nodeCatalog, validateOrganizationPlan } from './organization.js';
import type { OrganizationSpec } from './organization-types.js';

type Output = Record<string, any>;
type Node = OrganizationSpec['nodes'][number];
interface State { outputs: Record<string, Output>; consumed: Set<string>; executedNodeIds: string[]; executedGraphIds: string[]; visits: Record<string, number>; usage: {inputTokens:number;outputTokens:number;totalTokens:number}; usageKnown: boolean; }
interface Input { prior: Readonly<Record<string, Output>>; consumed: ReadonlySet<string>; }
interface Builder { node(id: string, type: string, deps: readonly string[], bind: (input: Input, outputs: Record<string, unknown>) => unknown): Builder; }
const isContext = (o: Output | undefined): o is Context => !!o && Array.isArray(o.items);
const message = (o: Output): Message | undefined => o.revisedResult ?? o.result ?? o.message;
const text = (m: Message): string => typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
function unwrap(type: string, value: unknown): Output {
  if (!value || typeof value !== 'object') throw new Error('Node returned no output');
  if (!type.startsWith('INFER.')) return value as Output;
  const result = value as Output;
  if (result.status !== 'success' || !result.output) throw new Error(`Node failed [${result.error?.code ?? result.status}]: ${result.error?.message ?? 'no output'}`);
  if (['error','cancelled'].includes(result.output.finishReason) || ['error','cancelled','timeout'].includes(result.output.stopReason)) throw new Error('Node did not complete a model response');
  return result.output;
}

/** The only driver interprets searched graphs/transitions. No fixed post-plan tool loop. */
export function runOrganization(runtime: DittoRuntime, model: ModelConfig, plan: AgentPlanSpec, task: BenchmarkTask, signal?: AbortSignal): Promise<AgentRunResult> {
  return captureModelOutputs(records => executeOrganization(runtime, model, plan, task, records, signal));
}
async function executeOrganization(runtime: DittoRuntime, model: ModelConfig, plan: AgentPlanSpec, task: BenchmarkTask, budgetRecords: ModelOutputRecord[], signal?: AbortSignal): Promise<AgentRunResult> {
  validateOrganizationPlan(plan);
  const spec = plan.organization!;
  if (task.dataset !== spec.dataset) throw new Error('Organization belongs to a different task family');
  const session = automationScope.getStore();
  if (task.dataset === 'automationbench' && !session) throw new Error('Automation requires an initialized official world');
  const catalog = nodeCatalog(spec.dataset); const nodes = new Map(spec.nodes.map(n => [n.id,n]));
  const outputIds = new WeakMap<Output,string>();
  const outputId = (out:Output):string => {let id=outputIds.get(out);if(!id){id=randomUUID();outputIds.set(out,id);}return id;};
  const normalized = (id: string, raw: unknown): Output => {
    try { return unwrap(catalog[nodes.get(id)!.template]!.type, raw); }
    catch(error) {
      const observed=budgetRecords.filter(r=>r.nodeId===id).at(-1);
      if(observed?.finishReason==='length') throw new OutputBudgetAnswerError('Received output exhausted its generation budget and could not satisfy the node output contract');
      throw error;
    }
  };
  const compiled = new Map(spec.graphs.map(g => {
    let builder = graph<Input>(`${plan.id}:${g.id}`) as unknown as Builder;
    for (const id of g.nodeIds) {
      const n = nodes.get(id)!;
      const local = n.dependencies.filter(d => g.nodeIds.includes(d));
      builder = builder.node(id, catalog[n.template]!.type, local, (input, outputs) => {
        const deps: Record<string, Output> = {};
        for (const d of n.dependencies) {
          const result = Object.hasOwn(outputs,d) ? normalized(d,outputs[d]) : input.prior[d];
          if (!result) throw new Error(`Missing declared dependency ${d} for ${id}`); deps[d] = result;
        }
        // Feedback is explicitly searched and reads only committed earlier graph runs.
        for (const d of n.feedback ?? []) if (input.prior[d]) deps[d] = input.prior[d];
        const consumed = new Set(input.consumed);
        for (const d of local) if (nodes.get(d)!.template === 'actor') {
          for (const call of deps[d]?.actionRequests ?? []) consumed.delete(`${d}\0${call.id}`);
        }
        return bind(n, deps, consumed, task, model, spec, session?.tools ?? [], outputId);
      });
    }
    return [g.id, builder] as const;
  }));
  return captureProviderDiagnostics(async records => {
    const state: State = {outputs:{},consumed:new Set(),executedNodeIds:[],executedGraphIds:[],visits:{},usage:{inputTokens:0,outputTokens:0,totalTokens:0},usageKnown:true};
    const definition = loop<BenchmarkTask, AgentRunResult>({ id:`${plan.id}:loop`, maxIterations:Number.MAX_SAFE_INTEGER,
      *plan() {
        let graphId: string | undefined = spec.entryGraphId;
        while (graphId !== undefined) {
          signal?.throwIfAborted(); session?.assertHealthy();
          const g = spec.graphs.find(g => g.id === graphId)!;
          const raw: Record<string, unknown> = yield* graphStep(compiled.get(graphId)! as any, {prior:{...state.outputs},consumed:new Set(state.consumed)}, signal ? {signal} : {});
          state.executedGraphIds.push(graphId); state.visits[graphId] = (state.visits[graphId] ?? 0) + 1;
          for (const id of g.nodeIds) {
            const n = nodes.get(id)!; const out = normalized(id,raw[id]); state.outputs[id] = out;
            state.executedNodeIds.push(id);
            if (n.template === 'actor') for (const call of out.actionRequests ?? []) state.consumed.delete(`${id}\0${call.id}`);
            if (n.template === 'act') for (const d of n.dependencies) {
              if (nodes.get(d)!.template === 'actor' && state.outputs[d]?.actionRequests?.some((call:ToolCall)=>call.id===out.callId)) state.consumed.add(`${d}\0${out.callId}`);
            }
            const usage = out.usage as Usage | undefined;
            if (catalog[n.template]!.type.startsWith('INFER.')) {
              state.usageKnown &&= usage?.inputTokens !== undefined && usage.outputTokens !== undefined;
              state.usage.inputTokens += usage?.inputTokens ?? 0; state.usage.outputTokens += usage?.outputTokens ?? 0;
              state.usage.totalTokens += usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
            }
            session?.record({kind:'organization-node',planId:plan.id,graphId,nodeId:id,nodeType:catalog[n.template]!.type,output:out});
          }
          session?.assertHealthy(); graphId = next(spec.transitions[graphId]!, state);
        }
        const output = state.outputs[spec.outputNodeId];
        const answer = output && resultMessage(output, nodes.get(spec.outputNodeId)!, state.outputs);
        if (!answer) throw new Error('Organization ended without its declared output');
        return {answer:text(answer),executedNodeIds:state.executedNodeIds,executedGraphIds:state.executedGraphIds,...state.usage,usageKnown:state.usageKnown};
      },
    });
    try {
      const result = await runtime.loop(definition, task, signal ? {signal} : {});
      return records.length ? {...result,...summarizeProviderDiagnostics(records)} : result;
    } catch (error) {
      if(error instanceof OutputBudgetAnswerError) {
        session?.assertHealthy();
        session?.record({kind:'model-output-budget',answerUsable:false,error:error.message});
        return {answer:'',executedNodeIds:state.executedNodeIds,executedGraphIds:state.executedGraphIds,
          ...(records.length?summarizeProviderDiagnostics(records):{...state.usage,usageKnown:state.usageKnown})};
      }
      throw new WorkflowExecutionError(error, summarizeProviderDiagnostics(records));
    }
  });
}

function resultMessage(out: Output, n: Node, outputs: Record<string, Output>): Message | undefined {
  if (n.template === 'output' || n.template === 'verify') {
    const own = message(out); if (own) return own;
    for (const d of [...n.dependencies].reverse()) if (outputs[d] && message(outputs[d])) return message(outputs[d]);
    return undefined;
  }
  return message(out);
}

function bind(n: Node, deps: Record<string, Output>, consumed: ReadonlySet<string>, task: BenchmarkTask, model: ModelConfig, spec: OrganizationSpec, tools: readonly unknown[], outputId:(out:Output)=>string): unknown {
  const definition = nodeCatalog(spec.dataset)[n.template]!; const config = definition.config as Record<string,any>;
  const values = Object.values(deps);
  const context = values.filter(isContext).at(-1);
  const metadata = {dataset:task.dataset,taskId:task.id,nodeId:n.id,nodeType:definition.type,planRole:n.template};
  const messages: Message[] = context ? context.items.map(item => contextMessage(item)) : [{role:'user',content:task.prompt}];
  const contextMessages = new Set(messages.map(m => JSON.stringify(m)));
  for (const [id, out] of Object.entries(deps)) {
    if (isContext(out) || nodesTemplate(spec,id) === 'act') continue;
    const m = message(out); if (!m || contextMessages.has(JSON.stringify(m))) continue;
    // Inference advice never impersonates a real tool observation.
    if (nodesTemplate(spec,id) === 'observe') messages.push({...m,metadata:{...m.metadata,actionRequestId:out.callId}});
    else messages.push({role:'user',content:`Result from ${id} (reasoning, not evidence of tool effects):\n${text(m)}`});
  }
  const request = {model,generation:config.generation,metadata,messages};
  switch (n.template) {
    case 'context': return {sources:[{id:`${task.id}:task`,content:task.prompt,metadata:{role:'user'}}]};
    case 'sample': case 'actor': return {...request,messages:[...(config.instruction ? [{role:'system',content:config.instruction}] : []),...messages], ...(n.template === 'actor' ? {actions:tools} : {})};
    case 'cot': return {...request,objective:config.instruction,strategy:{name:config.strategy,options:config.options},constraints:{maxSteps:Number.MAX_SAFE_INTEGER}};
    case 'verify': case 'revise': {
      const target = values.map(message).filter(Boolean).at(-1); if (!target) throw new Error('No explicitly wired reflection target');
      return {...request,target:{result:target},mode:config.mode,criteria:config.criteria.map((description:string,i:number)=>({id:`criterion-${i}`,description,weight:1}))};
    }
    case 'select': case 'merge': return {...request,mode:config.mode,candidates:Object.entries(deps).filter(([,out])=>!!message(out)).map(([id,out])=>({id,result:message(out)}))};
    case 'act': {
      const calls = Object.entries(deps).filter(([id])=>nodesTemplate(spec,id)==='actor').flatMap(([id,out])=>(out.actionRequests ?? []).map((call:ToolCall)=>({id,call})));
      const call = calls.find(({id,call}) => !consumed.has(`${id}\0${call.id}`))?.call; if (!call) throw new Error('ACT has no pending explicitly wired action');
      return {call};
    }
    case 'observe': { const external = values.find(out => typeof out.callId === 'string' && !out.message); if (!external) throw new Error('OBSERVE missing real tool result'); return {result:external}; }
    case 'update': {
      if (!context) throw new Error('UPDATE missing context');
      const add: ContextItem[] = [];
      const existing = new Set(context.items.map(item=>item.id));
      for (const [id,out] of Object.entries(deps)) {
        if (isContext(out)) continue;
        const m = message(out); if (!m) continue;
        const isObservation = nodesTemplate(spec,id) === 'observe';
        const key = `${id}:${outputId(out)}`; if (existing.has(key)) continue;
        const meta: Record<string,any> = {role:m.role,...m.metadata,...(isObservation?{actionRequestId:out.callId}:{})};
        if (out.actionRequests?.length) { meta.provider='openai-compatible'; meta.actionRequests=out.actionRequests; }
        add.push({id:key,content:m.content as ContextItem["content"],metadata:meta});
      }
      return {context,add};
    }
    case 'output': { const m = values.map(message).filter(Boolean).at(-1); if (!m) throw new Error('OUTPUT missing result'); return {deliveryId:`${task.id}:${n.id}:${randomUUID()}`,message:m}; }
    default: throw new Error('Unknown fixed node template');
  }
}
function nodesTemplate(spec: OrganizationSpec, id: string): string { return spec.nodes.find(n=>n.id===id)!.template; }
function contextMessage(item: ContextItem): Message { return {role:(item.metadata?.role ?? 'user') as Message['role'],content:(typeof item.content === "string" || Array.isArray(item.content) ? item.content : JSON.stringify(item.content)),...(item.metadata?{metadata:item.metadata}:{})}; }
function matches(c: OutputCondition, state: State): boolean {
  const out = state.outputs[c.sourceNodeId];
  if (c.operator === 'has-pending-actions' || c.operator === 'no-pending-actions') {
    const pending = (out?.actionRequests as ToolCall[]|undefined)?.some(call=>!state.consumed.has(`${c.sourceNodeId}\0${call.id}`)) ?? false;
    return c.operator === 'has-pending-actions' ? pending : !pending;
  }
  let value: unknown = out;
  for (const part of c.path ?? []) { value = value && typeof value === 'object' && Object.hasOwn(value,part) ? (value as Output)[part] : undefined; }
  if (c.operator === 'truthy') return !!value; if (c.operator === 'falsy') return !value;
  return c.operator === 'equals' ? isDeepStrictEqual(value,c.value) : !isDeepStrictEqual(value,c.value);
}
function next(t: GraphTransition, state: State): string | undefined {
  if (t.kind === 'end') return undefined;
  if (t.kind === 'next') return t.graphId;
  if (t.kind === 'switch') return t.cases.find(c=>matches(c.when,state))?.graphId ?? t.defaultGraphId;
  return matches(t.until,state) || (state.visits[t.graphId]??0) >= t.maxVisits ? t.nextGraphId : t.graphId;
}

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentPlanSpec, GraphTransition, WorkflowNodeSpec } from '../domain.js';
import { GENERATION } from '../protocol.js';
import type { OrganizationSpec } from './organization-types.js';

export const ORGANIZATION_VERSION = 'fixed-capabilities-topology-v1';
// Exact public task instruction used by the pinned MFlow baseline bridge.
export const AUTOMATION_INSTRUCTION = `Complete the requested business workflow in the official simulated APIs.
Discover precise endpoints with api_search; read each endpoint's method, parameter names and response schema before api_fetch.
api_fetch params and body must be JSON-encoded strings or null, never JSON objects. api_search requires an integer top_k. When a tool reports invalid arguments, correct the request and retry its intended action; preserve already successful effects.
Resolve names to real record IDs; follow pagination and cross-application identifiers. Keep filters, exact values, recipients, formatting, dates and conditions from the user's task.
Copy source field values exactly, including punctuation in phone numbers and identifiers. Do not normalize or reformat values unless the task explicitly requests it. Verify documented response field names before treating an absent or differently named field as a failed write.
Inspect current state before writes; every agent shares this task's world. Reuse completed work, never recreate records or repeat successful sends.
After each consequential write, inspect the resulting state and verify every requested postcondition. Repair concrete missing effects; do not replace tool execution with prose.
Only API observations and the user's request are evidence. Grading references and hidden world snapshots are unavailable. Summarize completed effects, identifiers and any specific blocker concisely. Planning, role-design and ranking stages must follow their requested control format, propose concrete dependencies and checks, and never claim unexecuted effects.`;

export interface NodeTemplate {
  readonly type: WorkflowNodeSpec['type'];
  readonly config: Readonly<Record<string, unknown>>;
  readonly description: string;
}

/** No prompt, tool schema, implementation, strategy or generation changes from proposals. */
export function nodeCatalog(dataset: OrganizationSpec['dataset']): Readonly<Record<string, NodeTemplate>> {
  const reasoning = { generation: GENERATION };
  return {
    context: { type: 'CONTEXT.LOAD', config: { includeTaskMetadata: false }, description: 'Load the original public task.' },
    sample: { type: 'INFER.REASONING.SAMPLE', config: { ...reasoning, role: 'solver', instruction: '' }, description: 'Generate a result from the task and explicitly wired evidence; no actions.' },
    cot: { type: 'INFER.REASONING.TRAJECTORY', config: { ...reasoning, instruction: 'Solve the original task using the supplied evidence.', strategy: 'cot', options: { rounds: 1 } }, description: 'One fixed chain-of-thought strategy.' },
    verify: { type: 'INFER.REASONING.REFLECT', config: { ...reasoning, mode: 'verify', criteria: ['Check the original task requirements against the supplied result and public evidence.'] }, description: 'Assess an explicitly wired result.' },
    revise: { type: 'INFER.REASONING.REFLECT', config: { ...reasoning, mode: 'revise', criteria: ['Correct concrete errors against the original task and public evidence.'] }, description: 'Revise an explicitly wired result.' },
    select: { type: 'INFER.REASONING.DELIBERATE', config: { ...reasoning, mode: 'select' }, description: 'Select among at least two explicitly wired results.' },
    merge: { type: 'INFER.REASONING.DELIBERATE', config: { ...reasoning, mode: 'merge' }, description: 'Integrate at least two explicitly wired results.' },
    ...(dataset === 'automationbench' ? {
      actor: { type: 'INFER.REASONING.SAMPLE' as const, config: { ...reasoning, role: 'solver', instruction: AUTOMATION_INSTRUCTION }, description: 'Generate a response or official tool requests from explicitly wired task/evidence. Does not execute actions.' },
      act: { type: 'INTERACTION.ACT.TOOL' as const, config: { template: 'act' }, description: 'Execute the next unconsumed request from a directly wired actor; tool capabilities are fixed.' },
      observe: { type: 'INTERACTION.OBSERVE' as const, config: { template: 'observe' }, description: 'Convert a directly wired real tool result to an observation.' },
      update: { type: 'CONTEXT.UPDATE' as const, config: { template: 'update' }, description: 'Append directly wired messages, requests and observations to a wired context.' },
      output: { type: 'INTERACTION.OUTPUT' as const, config: { template: 'output' }, description: 'Deliver the directly wired assistant result. Does not score or modify the world.' },
    } : {}),
  };
}

const safeId = /^[a-z][a-z0-9-]{0,63}$/;
const operators = new Set(['equals', 'not-equals', 'truthy', 'falsy', 'has-pending-actions', 'no-pending-actions']);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: Record<string, any>, allowed: readonly string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Organization contains an unsupported field');
}

export function validateOrganization(value: unknown): asserts value is OrganizationSpec {
  if (!object(value)) throw new Error('Organization must be an object');
  keys(value, ['version', 'dataset', 'nodes', 'graphs', 'entryGraphId', 'transitions', 'outputNodeId']);
  if (value.version !== 1 || !['math', 'automationbench'].includes(value.dataset)) throw new Error('Unknown organization protocol');
  const catalog = nodeCatalog(value.dataset);
  if (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 24) throw new Error('Organization needs 2..24 real nodes');
  const nodes = new Map<string, OrganizationSpec['nodes'][number]>();
  for (const n of value.nodes) {
    if (!object(n)) throw new Error('Invalid node'); keys(n, ['id', 'template', 'dependencies', 'feedback']);
    if (typeof n.id !== 'string' || !safeId.test(n.id) || nodes.has(n.id) || !Object.hasOwn(catalog, n.template)) throw new Error('Invalid/duplicate node or template');
    if (!Array.isArray(n.dependencies) || n.dependencies.some((d: unknown) => typeof d !== 'string') || new Set(n.dependencies).size !== n.dependencies.length) throw new Error('Invalid dependencies');
    if (n.feedback !== undefined && (!Array.isArray(n.feedback) || n.feedback.some((d: unknown) => typeof d !== 'string') || new Set(n.feedback).size !== n.feedback.length)) throw new Error('Invalid previous-iteration feedback');
    nodes.set(n.id, n as OrganizationSpec['nodes'][number]);
  }
  for (const n of nodes.values()) if (n.feedback?.some(d => !nodes.has(d))) throw new Error('Unknown feedback source');
  if (!nodes.has(value.outputNodeId) || !['sample', 'actor', 'cot', 'revise', 'verify', 'select', 'merge', 'output'].includes(nodes.get(value.outputNodeId)!.template)) throw new Error('Output must name a result-producing node');
  if (!Array.isArray(value.graphs) || value.graphs.length < 1 || value.graphs.length > 24) throw new Error('Invalid graphs');
  const owner = new Map<string, string>(); const graphIds = new Set<string>();
  for (const g of value.graphs) {
    if (!object(g)) throw new Error('Invalid graph'); keys(g, ['id', 'nodeIds']);
    if (!safeId.test(g.id) || graphIds.has(g.id) || !Array.isArray(g.nodeIds) || !g.nodeIds.length) throw new Error('Invalid/duplicate graph');
    graphIds.add(g.id); const seen = new Set<string>(); let acts = 0;
    for (const id of g.nodeIds) {
      const n = nodes.get(id); if (!n || owner.has(id)) throw new Error('Unknown or multiply assigned node');
      for (const d of n.dependencies) if (!nodes.has(d)) throw new Error('Unknown dependency');
      for (const d of n.dependencies) if (g.nodeIds.includes(d) && !seen.has(d)) throw new Error('Local dependencies must precede their consumer');
      owner.set(id, g.id); seen.add(id); if (n.template === 'act') acts++;
    }
    if (acts > 1) throw new Error('Use separate graphs for sequential tool dispatches to prevent duplicate writes');
  }
  if (owner.size !== nodes.size || !graphIds.has(value.entryGraphId) || !object(value.transitions)) throw new Error('Incomplete graph/entry assignments');
  if (Object.keys(value.transitions).length !== graphIds.size) throw new Error('Exactly one transition per graph is required');
  const edges = new Map<string, string[]>();
  const condition = (c: unknown): void => {
    if (!object(c)) throw new Error('Invalid condition'); keys(c, ['sourceNodeId', 'path', 'operator', 'value']);
    if (!nodes.has(c.sourceNodeId) || !operators.has(c.operator) || (c.path !== undefined && (!Array.isArray(c.path) || c.path.length > 8 || c.path.some((p: unknown) => typeof p !== 'string' || ['__proto__','constructor','prototype'].includes(p))))) throw new Error('Invalid condition source/operator/path');
  };
  for (const [id, t] of Object.entries(value.transitions)) {
    if (!graphIds.has(id) || !object(t)) throw new Error('Invalid transition source');
    const targets: string[] = [];
    if (t.kind === 'end') keys(t, ['kind']);
    else if (t.kind === 'next') { keys(t, ['kind','graphId']); targets.push(t.graphId); }
    else if (t.kind === 'switch') {
      keys(t, ['kind','cases','defaultGraphId']);
      if (!Array.isArray(t.cases) || t.cases.length > 24) throw new Error('Invalid switch');
      for (const c of t.cases) { if (!object(c)) throw new Error('Invalid switch case'); keys(c, ['when','graphId']); condition(c.when); targets.push(c.graphId); }
      if (t.defaultGraphId !== undefined) targets.push(t.defaultGraphId);
    } else if (t.kind === 'repeat') {
      keys(t, ['kind','graphId','maxVisits','until','nextGraphId']); condition(t.until);
      if (!Number.isSafeInteger(t.maxVisits) || t.maxVisits < 1) throw new Error('Invalid repeat bound');
      targets.push(t.graphId); if (t.nextGraphId !== undefined) targets.push(t.nextGraphId);
    } else throw new Error('Unsupported transition');
    if (targets.some(target => !graphIds.has(target))) throw new Error('Unknown transition target');
    edges.set(id, targets);
  }
  const noProgress = new Set(value.graphs.filter((g: any) => !g.nodeIds.some((id: string) => catalog[nodes.get(id)!.template]!.type.startsWith('INFER.') || nodes.get(id)!.template === 'act')).map((g: any) => g.id));
  const active = new Set<string>(), done = new Set<string>();
  const checkCycle = (id: string): void => {
    if (!noProgress.has(id) || done.has(id)) return;
    if (active.has(id)) throw new Error('A cycle must contain a model or tool execution node');
    active.add(id); for (const target of edges.get(id) ?? []) checkCycle(target); active.delete(id); done.add(id);
  };
  for (const id of graphIds) checkCycle(id);
  const reachable = new Set<string>(); const visit = (id: string): void => { if (reachable.has(id)) return; reachable.add(id); for (const target of edges.get(id) ?? []) visit(target); };
  visit(value.entryGraphId); if (reachable.size !== graphIds.size) throw new Error('Unreachable graph');
  // Definite availability at graph entry: intersect all predecessors, including cycles.
  const predecessors = new Map([...graphIds].map(id => [id, [...edges].filter(([, targets]) => targets.includes(id)).map(([from]) => from)]));
  const available = new Map([...graphIds].map(id => [id, id === value.entryGraphId ? new Set<string>() : new Set(nodes.keys())]));
  let changed = true;
  while (changed) { changed = false; for (const id of graphIds) {
    if (id === value.entryGraphId) continue;
    const pred = predecessors.get(id)!;
    const sets = pred.map(p => new Set([...available.get(p)!, ...value.graphs.find((g: any) => g.id === p)!.nodeIds]));
    const next = new Set([...nodes.keys()].filter(n => sets.length && sets.every(set => set.has(n))));
    if (next.size !== available.get(id)!.size) { available.set(id, next); changed = true; }
  } }
  for (const g of value.graphs) {
    const known = new Set(available.get(g.id));
    for (const id of g.nodeIds) {
      const n = nodes.get(id)!;
      if (n.dependencies.some(d => !known.has(d))) throw new Error(`Node ${id} has an unavailable dependency`);
      const deps = n.dependencies.map(d => nodes.get(d)!.template);
      if (['verify','revise'].includes(n.template) && !deps.some(d => ['sample','actor','cot','revise','select','merge'].includes(d))) throw new Error('Reflection requires an explicit result dependency');
      if (['select','merge'].includes(n.template) && deps.filter(d => ['sample','actor','cot','revise','select','merge'].includes(d)).length < 2) throw new Error('Deliberation requires two explicit results');
      if (n.template === 'act' && !deps.includes('actor')) throw new Error('ACT requires a directly wired actor');
      if (n.template === 'observe' && !deps.includes('act')) throw new Error('OBSERVE requires a directly wired ACT');
      if (n.template === 'update' && !deps.includes('context') && !deps.includes('update')) throw new Error('UPDATE requires a directly wired context');
      if (n.template === 'output' && !deps.some(d => ['sample','actor','cot','revise','select','merge'].includes(d))) throw new Error('OUTPUT requires a directly wired result');
      known.add(id);
    }
    const t = value.transitions[g.id];
    const conditions = t.kind === 'switch' ? t.cases.map((c: any) => c.when) : t.kind === 'repeat' ? [t.until] : [];
    if (conditions.some((c: any) => !known.has(c.sourceNodeId))) throw new Error('Transition condition source is unavailable');
    if ((t.kind === 'end' || t.kind === 'switch' && !t.defaultGraphId || t.kind === 'repeat' && !t.nextGraphId) && !known.has(value.outputNodeId)) throw new Error('A terminating graph must have the declared output available');
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));
  return value;
}
function normalized(spec: OrganizationSpec): OrganizationSpec {
  return canonical({...spec,nodes:[...spec.nodes].sort((a,b)=>a.id.localeCompare(b.id)),graphs:[...spec.graphs].sort((a,b)=>a.id.localeCompare(b.id))}) as OrganizationSpec;
}
export function organizationHash(spec: OrganizationSpec): string {
  return createHash('sha256').update(JSON.stringify(normalized(spec))).digest('hex');
}
export function buildOrganizationPlan(spec: OrganizationSpec, leaf = 'search-001'): AgentPlanSpec {
  validateOrganization(spec);
  spec = normalized(spec);
  const catalog = nodeCatalog(spec.dataset);
  const nodes = spec.nodes.map(n => ({ id: n.id, type: catalog[n.template]!.type, config: structuredClone(catalog[n.template]!.config), dependencies: [...n.dependencies], graphId: spec.graphs.find(g => g.nodeIds.includes(n.id))!.id })) as unknown as WorkflowNodeSpec[];
  return { id: `plan-${organizationHash(spec).slice(0,16)}`, leafSearchNodeId: leaf, nodes, graphs: structuredClone(spec.graphs),
    loop: { entryGraphId: spec.entryGraphId, transitions: structuredClone(spec.transitions), maxGraphRuns: Number.MAX_SAFE_INTEGER }, outputNodeId: spec.outputNodeId, organization: structuredClone(spec) };
}
export function validateOrganizationPlan(plan: AgentPlanSpec): void {
  if (!plan.organization || !isDeepStrictEqual(plan, buildOrganizationPlan(plan.organization, plan.leafSearchNodeId))) throw new Error('Plan differs from its fixed capability catalog or declared organization');
}
export function initialOrganization(dataset: OrganizationSpec['dataset']): OrganizationSpec {
  if (dataset === 'math') return { version: 1, dataset, nodes: [{ id:'context', template:'context', dependencies:[] }, { id:'answer', template:'sample', dependencies:['context'] }], graphs:[{id:'solve',nodeIds:['context','answer']}], entryGraphId:'solve', transitions:{solve:{kind:'end'}}, outputNodeId:'answer' };
  return { version:1, dataset, nodes:[
    {id:'context',template:'context',dependencies:[]}, {id:'actor',template:'actor',dependencies:['context'],feedback:['update']},
    {id:'act',template:'act',dependencies:['actor']}, {id:'observe',template:'observe',dependencies:['act']},
    {id:'update',template:'update',dependencies:['context','actor','observe'],feedback:['update']}, {id:'output',template:'output',dependencies:['actor']},
  ], graphs:[{id:'prepare',nodeIds:['context']},{id:'reason',nodeIds:['actor']},{id:'tools',nodeIds:['act','observe','update']},{id:'finish',nodeIds:['output']}], entryGraphId:'prepare', transitions:{
    prepare:{kind:'next',graphId:'reason'}, reason:{kind:'switch',cases:[{when:{sourceNodeId:'actor',operator:'has-pending-actions'},graphId:'tools'}],defaultGraphId:'finish'},
    tools:{kind:'switch',cases:[{when:{sourceNodeId:'actor',operator:'has-pending-actions'},graphId:'tools'}],defaultGraphId:'reason'}, finish:{kind:'end'},
  }, outputNodeId:'output' };
}

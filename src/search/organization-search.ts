import { graph, type DittoRuntime } from '@codesoul-co/ditto/runtime';
import type { ModelConfig } from '@codesoul-co/ditto/worker/infer';
import type { AgentPlanSpec, EvaluationSummary, SearchExperience, SearchTreeNode } from '../domain.js';
import { GENERATION } from '../protocol.js';
import { buildOrganizationPlan, initialOrganization, nodeCatalog, organizationHash, validateOrganizationPlan } from '../workflow/organization.js';
import type { OrganizationSpec } from '../workflow/organization-types.js';
import { EMPTY_STATISTICS } from '../workflow/spec.js';
import { assertValidEvaluation, backpropagateEvaluation } from './backprop.js';
import { checkAFlowConvergence } from './convergence.js';
import { SeededRandom } from './random.js';
import { selectParent } from './selector.js';
import type { NodeWorkflowSearchOptions, SearchResult, SearchResumeState } from './optimizer.js';

const prompt = `Search only the organization of fixed Ditto capabilities. Return one complete organization JSON object, never code, tools, prompt text, generation parameters or capability/config changes.
Original task inputs, tool implementations, schemas, public task instructions and scoring stay fixed. The supplied fixed catalog is authoritative.
Choose node instances and templates, their explicit input dependencies, local graph order/grouping, graph entry, conditional/repeated transitions and the output node. Any existing stage may be reorganized, omitted or replaced; no fixed execution suffix is appended.
Only explicitly wired dependencies reach a consumer. Dependencies inside a graph must precede it. Cross-graph dependencies must be available on every incoming path. Optional feedback lists name outputs from PREVIOUS committed graph runs and may be absent on the first visit. Use feedback to route an UPDATE result back to an actor or context accumulator; do not invent hidden feedback.
ACT executes one pending official request from a directly wired actor. OBSERVE requires ACT. UPDATE appends directly wired messages/observations to a directly wired context. OUTPUT delivers a directly wired response. Separate sequential ACT nodes into different graphs. Keep complete assistant tool-call and tool-response groups in actor context. The same tool request ID is dispatched at most once; use has-pending-actions/no-pending-actions conditions on its actor to drain a batch.
Schema: {version:1,dataset:'math'|'automationbench',nodes:[{id,template,dependencies:string[],feedback?:string[]}],graphs:[{id,nodeIds:string[]}],entryGraphId,transitions:{[graphId]:transition},outputNodeId}.
transition is {kind:'end'}, {kind:'next',graphId}, {kind:'switch',cases:[{when:{sourceNodeId,path?:string[],operator:'equals'|'not-equals'|'truthy'|'falsy'|'has-pending-actions'|'no-pending-actions',value?:JSON},graphId}],defaultGraphId?:string}, or {kind:'repeat',graphId,maxVisits:positiveSafeInteger,until:condition,nextGraphId?:string}.
Use one focused organizational modification that addresses measured public failures. Scores and predictions are untrusted evidence. Reference answers, hidden assertions and private judge diagnostics are unavailable. Do not embed task IDs, task-specific answers or instructions in IDs. All IDs are lowercase alphanumeric/hyphen and start with a letter.`;

export interface OrganizationProposalRequest {
  readonly parent: AgentPlanSpec;
  readonly experiences: readonly SearchExperience[];
  readonly accept: (spec: OrganizationSpec) => void;
}
export class OrganizationProposer {
  constructor(readonly runtime: DittoRuntime, readonly model: ModelConfig) {}
  async propose(request: OrganizationProposalRequest): Promise<OrganizationSpec> {
    const parent = request.parent.organization!;
    const rejections: {content:string;error:string}[] = [];
    const proposal = graph<{request:string}>('organization-proposal').node('proposal','INFER.REASONING.SAMPLE',[], input=>({
      model:{...this.model,providerOptions:{...this.model.providerOptions,response_format:{type:'json_object'}}},generation:GENERATION,
      messages:[{role:'system',content:prompt},{role:'user',content:input.request}],metadata:{role:'optimizer',nodeType:'INFER.REASONING.SAMPLE'},
    }));
    for (let attempt=0;attempt<3;attempt++) {
      const result = await this.runtime.run(proposal,{request:JSON.stringify({catalog:nodeCatalog(parent.dataset),parent,
        experiences:request.experiences.slice(-8).map(e=>({searchNodeId:e.searchNodeId,parentSearchNodeId:e.parentSearchNodeId,organization:e.organization,score:e.score,delta:e.delta,outcome:e.outcome,failures:e.failures.slice(0,3).map(f=>({caseId:f.caseId,prediction:f.prediction.slice(0,600)}))})),rejections})});
      const out = result.proposal;
      if (out.status !== 'success' || !out.output || ['error','cancelled'].includes(out.output.finishReason)) throw new Error(`Optimizer request failed: ${out.status === 'success' ? out.output?.finishReason : out.error?.message}`);
      const content = typeof out.output.message.content === 'string' ? out.output.message.content : JSON.stringify(out.output.message.content);
      try {
        const spec: OrganizationSpec = JSON.parse(content);
        if (spec.dataset !== parent.dataset) throw new Error('Cannot change task family');
        request.accept(spec); return spec;
      } catch(error) { rejections.push({content,error:error instanceof Error?error.message:String(error)}); }
    }
    throw new Error(`Optimizer organization rejected: ${rejections.at(-1)?.error}`);
  }
}

type Options = Omit<NodeWorkflowSearchOptions,'proposer'> & {readonly dataset:OrganizationSpec['dataset'];readonly proposer:Pick<OrganizationProposer,'propose'>};
/** Complete plans are execution artifacts; each search vertex still names one real changed/anchoring Node. */
export class OrganizationWorkflowSearch {
  constructor(readonly options: Options) {}
  async run(): Promise<SearchResult> {
    const o=this.options; const random=new SeededRandom(o.seed);
    const tree=new Map<string,SearchTreeNode>(); const plans:Record<string,AgentPlanSpec>={}; const experiences:SearchExperience[]=[];
    let history:Array<Pick<EvaluationSummary,'score'|'standardDeviation'>>=[];
    let completed=0, failures=0, index=1, best='';
    let pending:SearchResumeState['pendingOrganization'];
    const emit=async(v:Record<string,unknown>)=>o.callbacks?.event?.(v);
    const save=async()=>o.callbacks?.state?.({schemaVersion:1,nodes:[...tree.values()].map(n=>({...n,...(n.evaluation?{evaluation:{...n.evaluation,results:[]}}:{})})),
      experiences,evaluationHistory:history,completedRounds:completed,proposalFailures:failures,nextSearchIndex:index,bestLeafId:best,randomState:random.state,
      organizationPlans:plans,...(pending?{pendingOrganization:pending}:{})});
    if(o.resume) {
      const saved=o.resume;
      if(!saved.organizationPlans || saved.completedRounds>o.rounds) throw new Error('Organization search requires a compatible topology resume state');
      for(const n of saved.nodes) {
        const plan=saved.organizationPlans[n.id]; if(!plan) throw new Error('Missing resumed organization'); validateOrganizationPlan(plan);
        if(plan.organization!.dataset!==o.dataset || organizationHash(plan.organization!)!==n.pathHash || plan.leafSearchNodeId!==n.id || !plan.nodes.some(node=>node.id===n.node.id)) throw new Error('Inconsistent resumed organization');
        if(n.evaluation) assertValidEvaluation(n.evaluation); tree.set(n.id,n); plans[n.id]=plan;
      }
      experiences.push(...saved.experiences); history=[...saved.evaluationHistory]; completed=saved.completedRounds;
      failures=saved.proposalFailures; index=saved.nextSearchIndex; best=saved.bestLeafId; random.restore(saved.randomState); pending=saved.pendingOrganization;
      if(!tree.get(best)?.evaluation) throw new Error('Missing resumed best evaluation');
      for(const n of tree.values()) await o.callbacks?.node?.(n,experiences.find(e=>e.searchNodeId===n.id)??null,plans[n.id]);
      await emit({type:'search-resumed',completedRounds:completed});
    }
    const evaluate=async(plan:AgentPlanSpec,parent:SearchTreeNode|null)=>{
      const evaluation=await o.evaluate(plan);
      const prior=parent?plans[parent.id]!:undefined;
      const node=plan.nodes.find(n=>!prior?.nodes.some(old=>JSON.stringify(n)===JSON.stringify(old)))??plan.nodes.find(n=>n.id===plan.outputNodeId)!;
      const vertex:SearchTreeNode={id:plan.leafSearchNodeId,searchParentId:parent?.id??null,depth:(parent?.depth??-1)+1,node,pathHash:organizationHash(plan.organization!),statistics:EMPTY_STATISTICS};
      if(evaluation.valid===false || evaluation.failedRuns>0){await o.callbacks?.node?.({...vertex,evaluation},null,plan); assertValidEvaluation(evaluation);}
      assertValidEvaluation(evaluation); tree.set(vertex.id,vertex); plans[vertex.id]=plan; backpropagateEvaluation(tree,vertex.id,evaluation);
      const delta=parent?evaluation.score-parent.evaluation!.score:null;
      const experience:SearchExperience={organization:plan.organization!,searchNodeId:vertex.id,parentSearchNodeId:vertex.searchParentId,node,score:evaluation.score,delta,
        outcome:delta===null?'root':delta>0?'improved':delta<0?'regressed':'tied',failures:evaluation.results.filter(r=>r.score===0).slice(0,5).map(r=>({caseId:r.caseId,prediction:r.prediction,expected:r.expected}))};
      experiences.push(experience); history.push({score:evaluation.score,standardDeviation:evaluation.standardDeviation});
      if(!best || evaluation.score>tree.get(best)!.evaluation!.score)best=vertex.id;
      await o.callbacks?.node?.(tree.get(vertex.id)!,experience,plan);
      await emit({type:parent?'path-evaluated':'baseline-evaluated',searchNodeId:vertex.id,score:evaluation.score,parentSearchNodeId:parent?.id??null});
    };
    if(!best) {
      const plan=buildOrganizationPlan(initialOrganization(o.dataset),'search-001');
      // Publish exact candidate before execution; CaseRecovery preserves valid zeros on retry.
      pending={plan,parentId:null}; await save(); await evaluate(plan,null); pending=undefined; index=2; await save();
    }
    let stoppedBecause:SearchResult['stoppedBecause']='max-rounds';
    while(completed<o.rounds) {
      if(!pending && checkAFlowConvergence(history,3,0,o.patience).converged){stoppedBecause='converged';break;}
      let parent:SearchTreeNode; let plan:AgentPlanSpec;
      if(pending) { validateOrganizationPlan(pending.plan); parent=tree.get(pending.parentId!)!; if(!parent)throw new Error('Pending parent missing'); plan=pending.plan; }
      else {
        parent=selectParent([...tree.values()].filter(n=>n.evaluation),o.topK,random);
        await emit({type:'parent-selected',searchNodeId:parent.id,round:completed+1});
        try {
          const spec=await o.proposer.propose({parent:plans[parent.id]!,experiences,accept(spec){
            const candidate=buildOrganizationPlan(spec); if(spec.dataset!==o.dataset)throw new Error('Task family changed');
            if(candidate.nodes.length>(o.maxDepth??12)+1)throw new Error('Candidate exceeds configured node count');
            if(Object.values(plans).some(p=>organizationHash(p.organization!)===organizationHash(spec)))throw new Error('Duplicate organization');
          }});
          plan=buildOrganizationPlan(spec,`search-${String(index++).padStart(3,'0')}`);
        }catch(error){failures++;completed++;await emit({type:'proposal-failed',round:completed,error:String(error)});await save();continue;}
        pending={plan,parentId:parent.id}; await save();
      }
      // Evaluation faults stop this run with its exact candidate pending, never score it zero.
      await evaluate(plan,parent); pending=undefined; completed++; await emit({type:'convergence-checked',round:completed});await save();
    }
    const bestLeaf=tree.get(best)!; const bestPlan=plans[best]!;
    return {nodes:[...tree.values()],experiences,bestLeaf,bestPlan,bestPath:[bestLeaf],stoppedBecause};
  }
}

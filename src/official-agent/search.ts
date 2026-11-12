import {graph,type DittoRuntime} from '@codesoul-co/ditto/runtime';
import type {ModelConfig,NodeResult,SampleOutput} from '@codesoul-co/ditto/worker/infer';
import type {BenchmarkTask,DatasetName,EvaluationSummary} from '../domain.js';
import {GENERATION} from '../protocol.js';
import {OPTIMIZER_MAX_OUTPUT_TOKENS} from '../model-profile.js';
import {withWorkflowTimeBudget} from '../execution/time-budget.js';
export const OFFICIAL_OPTIMIZER_GENERATION=Object.freeze({...GENERATION,maxTokens:OPTIMIZER_MAX_OUTPUT_TOKENS});
export const OFFICIAL_OPTIMIZER_REQUEST_MS=180000;
import {SeededRandom} from '../search/random.js';
import {checkAFlowConvergence} from '../search/convergence.js';
import {captureProviderDiagnostics,summarizeProviderDiagnostics} from '../ditto/provider-diagnostics.js';
import {DefinitionError,digest,type DefinitionIssue,type ToolDefinition} from '../graph-agent/schema.js';
import {validateOfficialExploration as validateExploration,executedOfficialDirectionNodes as executedDirectionNodes} from './schema.js';
import {OFFICIAL_BASELINE as BASELINE_DEFINITION,validateOfficialDefinition as validateDefinition,validateOfficialChange,OFFICIAL_MUTATION_LIMITS,officialArtifactHash,officialNodes,OFFICIAL_CAPABILITIES as NODE_TYPES,type MutationExplanation,type OfficialAgentDefinition as GraphDefinition} from './schema.js';
import {OFFICIAL_DEFINITION_GUIDE as GRAPH_DEFINITION_GUIDE} from './prompts.js';
import {buildUnifiedFeedback as buildOfficialFeedback,PUBLIC_FEEDBACK_VERSION,type FeedbackEvaluation} from '../unified/feedback.js';
import {UNIFIED_DEFAULTS,UNIFIED_SEARCH_POLICY,comparableTokens} from '../unified/policy.js';
import {OFFICIAL_OPTIMIZER_SYSTEM as UNIFIED_OPTIMIZER_SYSTEM,OFFICIAL_OPTIMIZER_SYSTEM_SHA256 as UNIFIED_OPTIMIZER_SYSTEM_SHA256,OFFICIAL_PROMPT_VERSION as UNIFIED_PROMPT_VERSION} from './prompts.js';
import {publicAnswerContract,taskOutputRequirements} from '../benchmark/answer-contract.js';
import {EVIDENCE_PRESENTATION_VERSION} from '../graph-agent/evidence.js';
import {validateProposalEnvelope,OFFICIAL_PROPOSAL_SCHEMA,OFFICIAL_PROPOSAL_CONTRACT_VERSION} from './proposal-contract.js';
import {NATIVE_CONTRACTS,NATIVE_CONTRACTS_VERSION,HOST_TOOL_CONTRACTS,HOST_INFER_MESSAGES_SCHEMA} from './native-contracts.js';
import {publicEvaluationContract} from '../benchmark/evaluation-contract.js';
import {searchObjective,SEARCH_OBJECTIVE_VERSION} from '../unified/search-objective.js';
import {assertReusableStrategy,TASK_GENERALITY_VERSION} from './task-generality.js';
import {STANDARD_TOOL_CONTRACTS} from './tool-contracts.js';
import {MULTI_WORKER_POLICY,EXPLORATION_DIRECTIONS,directionForRound,explorationInstruction,type ExplorationDirection} from '../unified/exploration.js';

export interface OfficialEvaluation extends FeedbackEvaluation {}
export interface OfficialAttempt {
  readonly id:string;
  readonly designRound:number;
  readonly proposalAttempt:number;
  readonly parentId:string|null;
  readonly status:'valid'|'quality-pruned'|'invalid-proposal'|'invalid-evaluation'|'provider-error'|'resource-stopped';
  readonly explorationDirection?:ExplorationDirection;
  readonly definition?:GraphDefinition;
  readonly toolArtifacts?:readonly ToolDefinition[]|undefined;readonly mutation?:MutationExplanation|undefined;
  readonly rationale?:string;
  readonly artifactHash?:string;
  readonly evaluation?:OfficialEvaluation;
  readonly rawResponse?:string;
  readonly publicErrors?:readonly string[];
  readonly publicIssues?:readonly DefinitionIssue[];
}
export interface OfficialCandidate extends OfficialAttempt {
  readonly status:'valid'; readonly definition:GraphDefinition; readonly rationale:string;
  readonly artifactHash:string; readonly evaluation:OfficialEvaluation;
}
export interface OfficialPending {
  readonly id:string; readonly designRound:number; readonly proposalAttempt:number; readonly parentId:string|null;
  readonly definition:GraphDefinition; readonly rationale:string; readonly artifactHash:string; readonly rawResponse?:string;
  readonly explorationDirection?:ExplorationDirection;readonly toolArtifacts?:readonly ToolDefinition[]|undefined;readonly mutation?:MutationExplanation|undefined;
}
export interface OfficialSelection {
  readonly designRound:number; readonly parentId:string; readonly proposalAttempts:number;
  readonly explorationDirection?:ExplorationDirection;
  readonly contractRepair?:{readonly rejectedAttemptId:string;readonly definition?:GraphDefinition;
  readonly toolArtifacts?:readonly ToolDefinition[]|undefined;readonly mutation?:MutationExplanation|undefined;readonly rawResponse?:string;readonly errors:readonly string[];readonly issues?:readonly DefinitionIssue[]};
}
export interface OfficialSearchState {
  readonly schemaVersion:1; readonly policy:string; readonly configurationHash:string; readonly systemPromptSha256:string;
  readonly validEvaluations:number; readonly designRoundsCompleted:number; readonly proposalAttempts:number;
  readonly prunedEvaluations:number; readonly engineeringFailures:number;
  readonly nextAttemptIndex:number; readonly randomState:number;
  readonly optimizerUsage:{readonly providerAttempts:number;readonly failedProviderAttempts:number;readonly unknownUsageAttempts:number;readonly inputTokens:number;readonly outputTokens:number;readonly totalTokens:number};
  readonly history:readonly OfficialAttempt[];
  readonly selection?:OfficialSelection; readonly pending?:OfficialPending;
}
export interface OfficialSearchOptions {
  readonly runtime:Pick<DittoRuntime,'run'>; readonly model:ModelConfig; readonly dataset:DatasetName;
  readonly publicTasks:readonly BenchmarkTask[]; readonly expectedExamples?:number; readonly expectedRepeats?:number;
  readonly maxValidEvaluations?:number; readonly maxDesignRounds?:number; readonly maxProposalAttempts?:number;
  readonly deadlineAt?:number; readonly seed?:number; readonly patience?:number; readonly identity?:string;
  readonly initialDefinition?:GraphDefinition;readonly initialization?:unknown;
  /** Complete measured Search candidates whose execution identity is checked by the caller. */
  readonly measuredSeeds?:readonly OfficialCandidate[];
  readonly targetScore?:number;
  /** Explicit opt-out is for isolated protocol tests/legacy diagnostic comparisons. Main search enables protected directions. */
  readonly exploration?:false;
  readonly evaluate:(definition:GraphDefinition,id:string,reference?:OfficialCandidate,context?:{direction?:ExplorationDirection;toolArtifacts?:readonly ToolDefinition[]|undefined})=>Promise<OfficialEvaluation>;
  readonly resume?:OfficialSearchState;
  readonly save?:(state:OfficialSearchState)=>void|Promise<void>;
  readonly event?:(event:Readonly<Record<string,unknown>>)=>void|Promise<void>;
}

const proposalGraph=graph<{model:ModelConfig;request:string;id:string}>('unified-declarative-proposal')
  .node('proposal','INFER.REASONING.SAMPLE',[],input=>({model:input.model,generation:OFFICIAL_OPTIMIZER_GENERATION,
    messages:[{role:'system',content:UNIFIED_OPTIMIZER_SYSTEM},{role:'user',content:input.request}],
    metadata:{experiment:UNIFIED_SEARCH_POLICY,role:'optimizer',candidateId:input.id,systemPromptVersion:UNIFIED_PROMPT_VERSION}}));
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const integer=(value:number,name:string,min=1,max=100000)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Invalid ${name}`);};
const emptyUsage=()=>({providerAttempts:0,failedProviderAttempts:0,unknownUsageAttempts:0,inputTokens:0,outputTokens:0,totalTokens:0});

export function isOfficialCandidate(value:OfficialAttempt):value is OfficialCandidate {
  const evaluation=value.evaluation;
  return value.status==='valid'&&value.definition!==undefined&&evaluation!==undefined&&value.rationale!==undefined&&value.artifactHash!==undefined
    &&evaluation.valid===true&&evaluation.failedRuns===0&&(evaluation.candidateFailureRuns??0)===0
    &&evaluation.results.length===evaluation.examples*evaluation.repeats&&new Set(evaluation.results.map(row=>row.caseId)).size===evaluation.results.length
    &&evaluation.results.every(row=>row.valid===true&&row.error===undefined&&row.candidateFailure===undefined);
}
export function compareOfficialCandidates(a:OfficialCandidate,b:OfficialCandidate):number {
  return b.evaluation.score-a.evaluation.score||comparableTokens(a.evaluation)-comparableTokens(b.evaluation)||a.id.localeCompare(b.id);
}
export function bestOfficialCandidate(history:readonly OfficialAttempt[]):OfficialCandidate|undefined {
  return history.filter(isOfficialCandidate).sort(compareOfficialCandidates)[0];
}
export function unifiedParentProbabilities(history:readonly OfficialAttempt[],topK=4):readonly {id:string;probability:number}[]{
  integer(topK,'topK',1,100);
  const pool=history.filter(isOfficialCandidate).sort(compareOfficialCandidates).slice(0,topK);
  if(!pool.length)throw Error('No complete valid parent is available');
  const maximum=pool[0]!.evaluation.score,weights=pool.map(row=>Math.exp(20*(row.evaluation.score-maximum))),total=weights.reduce((sum,value)=>sum+value,0);
  return pool.map((row,index)=>({id:row.id,probability:.3/pool.length+.7*weights[index]!/total}));
}
export function selectOfficialParent(history:readonly OfficialAttempt[],random:SeededRandom):OfficialCandidate {
  const probabilities=unifiedParentProbabilities(history),draw=random.next();let cumulative=0;
  for(const row of probabilities){cumulative+=row.probability;if(draw<=cumulative)return history.find(candidate=>candidate.id===row.id)! as OfficialCandidate;}
  return history.find(candidate=>candidate.id===probabilities.at(-1)!.id)! as OfficialCandidate;
}

/** Required task/repeat identities, not only a matching row count, define a full evaluation. */
export function assertOfficialComplete(evaluation:EvaluationSummary,tasks:readonly BenchmarkTask[],repeats:number):void {
  const expected=new Set(tasks.flatMap(task=>Array.from({length:repeats},(_,index)=>`${task.id}#${index+1}`)));
  if(evaluation.valid!==true||evaluation.examples!==tasks.length||evaluation.repeats!==repeats||evaluation.results.length!==expected.size
    ||evaluation.failedRuns!==0||evaluation.successfulRuns!==expected.size||(evaluation.candidateFailureRuns??0)>0
    ||!Number.isFinite(evaluation.score)||evaluation.score<0||evaluation.score>1||!Number.isFinite(evaluation.standardDeviation)||evaluation.standardDeviation<0)
    throw Error('A complete valid evaluation requires all prescribed tasks and repeats without engineering-invalid cases');
  for(const row of evaluation.results){
    if(!expected.delete(row.caseId)||row.valid!==true||row.error!==undefined||row.candidateFailure!==undefined||!Number.isFinite(row.score)||row.score<0||row.score>1)
      throw Error('Evaluation contains missing, duplicate, unexpected or engineering-invalid task/repeat records');
  }
  const score=evaluation.results.reduce((sum,row)=>sum+row.score,0)/evaluation.results.length;
  if(expected.size||Math.abs(evaluation.score-score)>1e-12)throw Error('Evaluation score does not match its complete case collection');
}
function infrastructure(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const value=error as {infrastructureFailure?:boolean;code?:string;failureKind?:string};
  return value.infrastructureFailure===true||value.code==='SEARCH_BUDGET_EXHAUSTED'||['provider','timeout','judge'].includes(value.failureKind??'');
}
function publicContractError(error:unknown):string {
  const value=error as {publicMessage?:unknown};
  // Host evaluator errors may include private scorer detail; only explicit public messages cross that boundary.
  return typeof value?.publicMessage==='string'?value.publicMessage.slice(0,1600):'Execution/interface validation failed; inspect the saved host diagnostics. Repair the candidate contract, not the benchmark or scorer.';
}

export function parseOfficialProposal(content:string):{rationale:string;definition:GraphDefinition;toolArtifacts?:readonly ToolDefinition[]|undefined;mutation?:MutationExplanation}{
  let value:Record<string,unknown>;
  try { value=JSON.parse(content.trim()) as Record<string,unknown>; }
  catch (error) {
    const detail=error instanceof Error?error.message:String(error),position=/position (\d+)/.exec(detail);
    const offset=position?Number(position[1]):0,snippet=content.trim().slice(Math.max(0,offset-80),offset+80);
    throw Error(`Invalid proposal JSON: ${detail}. Near ${JSON.stringify(snippet)}. Escape quotes/backslashes/newlines inside strings; return one complete JSON object.`);
  }
  const envelope=validateProposalEnvelope(value);
  const tools=envelope.toolArtifacts;const definition=validateDefinition(envelope.definition,tools);
  if((definition as {version:number}).version!==1)throw Error('Official candidates must use definition version:1');
  return {rationale:envelope.rationale,definition,...(tools?{toolArtifacts:tools}:{}),...(envelope.mutation?{mutation:envelope.mutation}:{})};
}

/** One measured parent per design round. Engineering repairs stay in that round and retain all attempts. */
export async function searchOfficialWorkflows(options:OfficialSearchOptions):Promise<{
  state:OfficialSearchState;best:OfficialCandidate;stoppedBecause:'valid-budget'|'design-budget'|'converged'|'walltime-budget'|'score-target';
}>{
  const maxValid=options.maxValidEvaluations??UNIFIED_DEFAULTS.maxValidEvaluations,maxDesign=options.maxDesignRounds??UNIFIED_DEFAULTS.maxDesignRounds;
  const maxAttempts=options.maxProposalAttempts??UNIFIED_DEFAULTS.maxProposalAttempts,repeats=options.expectedRepeats??UNIFIED_DEFAULTS.validationRepeats;
  const patience=options.patience??UNIFIED_DEFAULTS.patience,seed=options.seed??UNIFIED_DEFAULTS.seed;
  for(const [name,value]of Object.entries({maxValid,maxDesign,maxAttempts,repeats,patience}))integer(value,name);
  integer(seed,'seed',0,0xffffffff);
  if(options.targetScore!==undefined&&(!Number.isFinite(options.targetScore)||options.targetScore<0||options.targetScore>1))throw Error('Invalid target score');
  const seeds=options.measuredSeeds??[];
  if(seeds.length>maxValid)throw Error('Measured seeds exceed the valid evaluation budget');
  for(const [index,candidate]of seeds.entries()){
   if(candidate.id!==`official-${String(index+1).padStart(4,'0')}`||candidate.parentId!==null||!isOfficialCandidate(candidate))throw Error('Measured seeds must be complete unique numbered roots');
   validateDefinition(candidate.definition,candidate.toolArtifacts);
   assertReusableStrategy(candidate.definition,options.publicTasks);
   if(officialArtifactHash(candidate.definition,candidate.toolArtifacts)!==candidate.artifactHash)throw Error('Measured seed artifact differs');
   assertOfficialComplete(candidate.evaluation,options.publicTasks,repeats);
  }
  if(!options.publicTasks.length||new Set(options.publicTasks.map(task=>task.id)).size!==options.publicTasks.length
    ||options.publicTasks.some(task=>task.dataset!==options.dataset)||options.expectedExamples!==undefined&&options.expectedExamples!==options.publicTasks.length)
    throw Error('Official search requires the complete unique public task collection for its declared evaluation');
  const baseline=validateDefinition(options.initialDefinition??{...structuredClone(BASELINE_DEFINITION),version:1});
  assertReusableStrategy(baseline,options.publicTasks);
  const explore=options.exploration!==false;
  if(explore&&officialNodes(baseline).filter(n=>n.node.type==='INFER.REASONING.SAMPLE').length>1)throw Error('Protected multi-worker search requires a baseline with at most one SAMPLE');
  if((baseline as {version:number}).version!==1)throw Error('Official baseline must use version:1');
  const configurationHash=digest({policy:UNIFIED_SEARCH_POLICY,mutationPolicy:OFFICIAL_MUTATION_LIMITS,deadlineAt:options.deadlineAt??null,directionResources:'shared-global-no-direction-caps-v1',searchObjective:SEARCH_OBJECTIVE_VERSION,taskGenerality:TASK_GENERALITY_VERSION,system:UNIFIED_OPTIMIZER_SYSTEM_SHA256,publicFeedback:PUBLIC_FEEDBACK_VERSION,contracts:{proposal:OFFICIAL_PROPOSAL_CONTRACT_VERSION,native:NATIVE_CONTRACTS_VERSION,guide:digest(GRAPH_DEFINITION_GUIDE)},identity:options.identity??null,dataset:options.dataset,
    model:options.model,generation:GENERATION,optimizerGeneration:OFFICIAL_OPTIMIZER_GENERATION,optimizerRequestMs:OFFICIAL_OPTIMIZER_REQUEST_MS,answerContract:publicAnswerContract(options.dataset),evaluationContract:publicEvaluationContract(options.dataset),evidencePresentation:EVIDENCE_PRESENTATION_VERSION,exploration:explore?MULTI_WORKER_POLICY:false,taskIds:options.publicTasks.map(task=>task.id),repeats,maxValid,maxDesign,maxAttempts,patience,seed,targetScore:options.targetScore??null,measuredSeeds:seeds.map(candidate=>({id:candidate.id,artifactHash:candidate.artifactHash,evaluation:digest(candidate.evaluation)})),baseline:officialArtifactHash(baseline),initialization:options.initialization??null});
  const random=new SeededRandom(seed);
  let state:OfficialSearchState=options.resume?structuredClone(options.resume):{schemaVersion:1,policy:UNIFIED_SEARCH_POLICY,configurationHash,
    systemPromptSha256:UNIFIED_OPTIMIZER_SYSTEM_SHA256,validEvaluations:seeds.length,designRoundsCompleted:0,proposalAttempts:0,prunedEvaluations:0,engineeringFailures:0,
    nextAttemptIndex:seeds.length+1,randomState:random.state,optimizerUsage:emptyUsage(),history:structuredClone(seeds)};
  if(state.schemaVersion!==1||state.policy!==UNIFIED_SEARCH_POLICY||state.configurationHash!==configurationHash||state.systemPromptSha256!==UNIFIED_OPTIMIZER_SYSTEM_SHA256)
    throw Error('Search resume model/data/runtime/prompt/configuration identity differs');
  random.restore(state.randomState);
  if(state.validEvaluations!==state.history.filter(isOfficialCandidate).length||state.prunedEvaluations!==state.history.filter(row=>row.status==='quality-pruned').length
    ||new Set(state.history.map(row=>row.id)).size!==state.history.length)throw Error('Search checkpoint counters/history disagree');
  for(const candidate of state.history.filter(isOfficialCandidate)){
    assertReusableStrategy(candidate.definition,options.publicTasks);
    validateDefinition(candidate.definition,candidate.toolArtifacts);if(officialArtifactHash(candidate.definition,candidate.toolArtifacts)!==candidate.artifactHash)throw Error('Saved candidate artifact identity changed');
    assertOfficialComplete(candidate.evaluation,options.publicTasks,repeats);
  }
  const save=async()=>{try{await options.save?.(structuredClone(state));}catch(error){throw Object.assign(error instanceof Error?error:new Error(message(error)),{checkpointFailure:true});}};
  const event=async(value:Readonly<Record<string,unknown>>)=>{try{await options.event?.(value);}catch(error){throw Object.assign(error instanceof Error?error:new Error(message(error)),{checkpointFailure:true});}};
  const nextId=()=>`official-${String(state.nextAttemptIndex).padStart(4,'0')}`;
  if(!state.history.length&&!state.pending){
    state={...state,pending:{id:nextId(),designRound:0,proposalAttempt:0,parentId:null,definition:baseline,artifactHash:officialArtifactHash(baseline),rationale:'Frozen dataset-independent baseline; its complete evaluation counts toward the valid budget.'},nextAttemptIndex:state.nextAttemptIndex+1};
    await save();
  }
  let stoppedBecause:'valid-budget'|'design-budget'|'converged'|'walltime-budget'|'score-target'='valid-budget';
  while(true){
    if(state.pending){
      const pending=state.pending;
      validateDefinition(pending.definition,pending.toolArtifacts);
      assertReusableStrategy(pending.definition,options.publicTasks);
      if(officialArtifactHash(pending.definition,pending.toolArtifacts)!==pending.artifactHash)throw Error('Pending artifact identity mismatch');
      if(pending.parentId!==null){const parent=state.history.find(row=>row.id===pending.parentId);if(!parent||!isOfficialCandidate(parent))throw Error('Pending parent is not a complete valid candidate');validateOfficialChange(parent.definition,pending.definition,pending.mutation,parent.toolArtifacts,pending.toolArtifacts);}
      let evaluation:OfficialEvaluation|undefined;
      try{
        const reference=bestOfficialCandidate(state.history);
        evaluation=await options.evaluate(pending.definition,pending.id,reference,{...(pending.explorationDirection?{direction:pending.explorationDirection}:{}),toolArtifacts:pending.toolArtifacts});
        if(pending.explorationDirection&&!executedDirectionNodes(pending.definition,pending.explorationDirection,evaluation.publicTraces??[]).length&&!(evaluation.publicTraces??[]).some(t=>(t as {modelFailure?:unknown}).modelFailure)){const error=new DefinitionError(`No operation from protected direction ${pending.explorationDirection} executed on the measured tasks`,'exploration.execution','Connect this worker to the actual visited route and consume its output; unused declarations do not satisfy the quota.');throw Object.assign(error,{publicMessage:error.message,publicIssue:error.issue});}
        if(evaluation.qualityPruned){
          if(pending.designRound===0||evaluation.valid!==true||evaluation.examples>=options.publicTasks.length)throw Error('A baseline/full or engineering-invalid evaluation cannot be quality-pruned');
          assertOfficialComplete(evaluation,options.publicTasks.slice(0,evaluation.examples),repeats);
          const attempt:OfficialAttempt={...pending,status:'quality-pruned',evaluation};
          const {pending:_pending,selection:_selection,...rest}=state;
          state={...rest,history:[...state.history,attempt],prunedEvaluations:state.prunedEvaluations+1,designRoundsCompleted:pending.designRound};
          await save();await event({type:'unified-quality-pruned',attempt});continue;
        }
        assertOfficialComplete(evaluation,options.publicTasks,repeats);
        const attempt:OfficialCandidate={...pending,status:'valid',evaluation};
        const {pending:_pending,selection:_selection,...rest}=state;
        state={...rest,history:[...state.history,attempt],validEvaluations:state.validEvaluations+1,designRoundsCompleted:Math.max(state.designRoundsCompleted,pending.designRound)};
        await save();await event({type:'unified-evaluation-completed',attempt,validEvaluations:state.validEvaluations});continue;
      }catch(error){
        if((error as {checkpointFailure?:boolean})?.checkpointFailure)throw error;
        if((error as {code?:string})?.code==='SEARCH_DIRECTION_BUDGET'){
          const attempt:OfficialAttempt={...pending,status:'resource-stopped',publicErrors:['Protected direction budget exhausted; partial measurements remain in checkpoints and are not quality zeroes.']};
          const{pending:_pending,selection:_selection,...rest}=state;state={...rest,history:[...state.history,attempt],designRoundsCompleted:pending.designRound};
          await save();await event({type:'unified-direction-budget-stopped',attempt});continue;
        }
        if(infrastructure(error)){await save();await event({type:'unified-evaluation-interrupted',id:pending.id,artifactHash:pending.artifactHash});throw error;}
        const publicError=evaluation?.engineeringIssues?.map(issue=>`${issue.code}: ${issue.message}`).join('\n')||publicContractError(error);
        const publicIssue=(error as {publicIssue?:DefinitionIssue}).publicIssue??{code:'B_EXECUTION_CONTRACT',path:'workflow',message:publicError,repairHint:'Repair the indicated public workflow interface; never change the benchmark or scorer.'};
        const attempt:OfficialAttempt={...pending,status:'invalid-evaluation',...(evaluation?{evaluation}:{}),publicErrors:[publicError],publicIssues:[publicIssue]};
        const {pending:_pending,...rest}=state;
        const selection=state.selection;
        state={...rest,history:[...state.history,attempt],engineeringFailures:state.engineeringFailures+1,
          ...(selection?{selection:{...selection,contractRepair:{rejectedAttemptId:pending.id,definition:pending.definition,
            ...(pending.rawResponse!==undefined?{rawResponse:pending.rawResponse}:{}),errors:[...new Set([...(selection.contractRepair?.errors??[]),publicError])],issues:[...(selection.contractRepair?.issues??[]),publicIssue]}}}:{})};
        await save();await event({type:'unified-evaluation-invalid',attempt});
        if(pending.designRound===0)throw Error('Frozen baseline evaluation is engineering-invalid; no valid parent can be fabricated');
        continue;
      }
    }
    if(options.targetScore!==undefined&&(bestOfficialCandidate(state.history)?.evaluation.score??-1)>=options.targetScore){stoppedBecause='score-target';break;}
    if(state.validEvaluations>=maxValid){stoppedBecause='valid-budget';break;}
    const complete=state.history.filter(isOfficialCandidate);
    if(!state.selection&&(!explore||state.designRoundsCompleted>=EXPLORATION_DIRECTIONS.length)&&checkAFlowConvergence(complete.map(row=>row.evaluation),3,0,patience).converged){stoppedBecause='converged';break;}
    if(!state.selection&&options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt){stoppedBecause='walltime-budget';break;}
    if(!state.selection&&state.designRoundsCompleted>=maxDesign){stoppedBecause='design-budget';break;}
    if(!state.selection){
      const parent=selectOfficialParent(state.history,random);
      const round=state.designRoundsCompleted+1;
      state={...state,selection:{designRound:round,parentId:parent.id,proposalAttempts:0,...(explore?{explorationDirection:directionForRound(round)}:{})},randomState:random.state};
      await save();await event({type:'unified-parent-selected',designRound:round,parentId:parent.id,explorationDirection:state.selection!.explorationDirection,probabilities:unifiedParentProbabilities(state.history)});
    }
    const selection=state.selection!;
    if(selection.proposalAttempts>=maxAttempts){
      const {selection:_selection,...rest}=state;state={...rest,designRoundsCompleted:selection.designRound};
      await save();await event({type:'unified-design-skipped',designRound:selection.designRound,parentId:selection.parentId,reason:'bounded-engineering-repairs-exhausted'});continue;
    }
    const parent=state.history.find(row=>row.id===selection.parentId);
    if(!parent||!isOfficialCandidate(parent))throw Error('Selected parent lacks complete valid measurement');
    const id=nextId(),proposalAttempt=selection.proposalAttempts+1;
    state={...state,nextAttemptIndex:state.nextAttemptIndex+1,proposalAttempts:state.proposalAttempts+1,selection:{...selection,proposalAttempts:proposalAttempt}};
    const request=JSON.stringify({initialization:options.initialization,mode:selection.contractRepair?'ENGINEERING REPAIR':'QUALITY SEARCH',dataset:options.dataset,
      searchObjective:searchObjective(state.history,options.targetScore),
      reusableStrategyPolicy:{version:TASK_GENERALITY_VERSION,rule:'Reusable config must not contain measured task-specific function identifiers or per-function solution rules. Obtain the actual signature from the current public task at execution time. Ordinary generic vocabulary and official tool names remain available.'},
      parent:{id:parent.id,definition:parent.definition,toolArtifacts:parent.toolArtifacts??[],score:parent.evaluation.score,totalTokens:parent.evaluation.totalTokens},
      immutableProtocol:{policy:UNIFIED_SEARCH_POLICY,repeats,fullExamples:options.publicTasks.length,systemVersion:UNIFIED_PROMPT_VERSION,
        systemPromptSha256:UNIFIED_OPTIMIZER_SYSTEM_SHA256,publicAnswerContract:publicAnswerContract(options.dataset),evaluationContract:publicEvaluationContract(options.dataset),capabilities:NODE_TYPES,remainingValidBudget:maxValid-state.validEvaluations,
        mutationLimits:OFFICIAL_MUTATION_LIMITS},
      interfaceGuide:GRAPH_DEFINITION_GUIDE,
      proposalContract:{version:OFFICIAL_PROPOSAL_CONTRACT_VERSION,schema:OFFICIAL_PROPOSAL_SCHEMA},
      nativeCatalogue:{version:NATIVE_CONTRACTS_VERSION,nodes:NATIVE_CONTRACTS},
      providerMessages:{schema:HOST_INFER_MESSAGES_SCHEMA,scope:'Fixed text-model host adapter; native Infer unknown[] is not permission to send arbitrary arrays/JSON to HTTP. Serialize data explicitly with HOST.DATA.TRANSFORM text/json/concat.'},
      registeredTools:[...STANDARD_TOOL_CONTRACTS,...Object.entries(HOST_TOOL_CONTRACTS).map(([name,contract])=>({name,...contract})).filter(tool=>options.dataset==='bfcl'?String(tool.name).startsWith('bfcl_'):options.dataset==='automationbench'?['api_search','api_fetch','base64_encode'].includes(String(tool.name)):false)],
      ...(options.dataset==='bfcl'?{additionalHostOperations:{'bfcl-history':{
        input:'{operation:"bfcl-history", tool:actualExecutedInterfaceName, decision:actualExecutedParsedDecision, value:actualPublicObservation, evidence:sourceLabeledEvidenceString, history:priorMessageArray}',
        output:'{complete:boolean,history:Message[]}: complete is the actual public complete flag, not model text. Replace earlier full BFCL snapshots with the latest cumulative public snapshot; retain tagged errors and append later incremental observations. Does not choose actions, advance turns, invent functions or access private state.',
      }}}:{}),
      ...(options.dataset==='automationbench'?{additionalHostOperations:{'tool-history':{input:'{operation:"tool-history", tool:actualExecutedInterfaceName, decision:actualExecutedParsedDecision, value:nativeObservation, evidence:sourceLabeledEvidenceString, history:priorMessageArray}',output:'{complete:false,history:Message[]}: preserve actual assistant action plus paired observations; no success inference, action selection or automatic completion.'},'tool-history-progress':{input:'Same fields as tool-history, operation:"tool-history-progress", optional progressThreshold:integer 2..10, compactRepeatedFailures:boolean.',output:'{complete:false,history:Message[],progress:{stalled:boolean,businessError:boolean,consecutiveEquivalentFailures:number,observationIndex:number,...}}. Counts are supplied by the task-local host observer of actual official ACT.TOOL calls, never model-reported history. An unchanged error for the same request increments the count; empty optional params/body are equivalent for counting only. Changed substantive arguments, results or successful calls reset it. Compaction retains the actual last pair and authoritative count; full execution traces remain intact. A workflow may consume stalled in an explicit Loop transition to a native reviewer, alternate route or bounded exit. This signal selects no business action and proves no task completion.'}}}:{}),
      ...(selection.explorationDirection?{exploration:explorationInstruction(selection.explorationDirection)}:{}),
      authorizedRetrievalTargets:[{name:'task-public',scope:'only this task public input; never other tasks, labels, confirmation or Test'}],
      publicTaskExamples:options.publicTasks.slice(0,2).map(task=>({id:task.id,prompt:task.prompt,outputInstruction:taskOutputRequirements(task)})),
      history:state.history.map(row=>({id:row.id,parentId:row.parentId,status:row.status,explorationDirection:row.explorationDirection,...(row.rationale?{rationale:row.rationale.slice(0,1000)}:{}),
        ...(isOfficialCandidate(row)?{score:row.evaluation.score,totalTokens:row.evaluation.totalTokens}:{}),...(row.status==='quality-pruned'?{stage:row.evaluation?.examples,stageScore:row.evaluation?.score}:{}),})),
      measuredFeedback:buildOfficialFeedback(state.history,options.publicTasks,{failureOffset:(selection.designRound-1)*4}),
      ...(selection.contractRepair?{contractRepair:selection.contractRepair}:{}),});
    await save();await event({type:'unified-proposal-request',id,designRound:selection.designRound,proposalAttempt,systemPrompt:UNIFIED_OPTIMIZER_SYSTEM,request});
    let rawResponse:string|undefined,definition:GraphDefinition|undefined,rationale:string|undefined,toolArtifacts:readonly ToolDefinition[]|undefined,mutation:MutationExplanation|undefined;
    let records:Parameters<typeof summarizeProviderDiagnostics>[0]=[];
    try{
      let sampled:NodeResult<SampleOutput>;
      try{
        const output=await captureProviderDiagnostics(async observed=>{records=observed;return withWorkflowTimeBudget({requestMs:OFFICIAL_OPTIMIZER_REQUEST_MS,workflowMs:null,reason:'Bounded declarative proposal generation; worker generation budget is unchanged'},()=>options.runtime.run(proposalGraph,{model:options.model,request,id}));});
        sampled=output.proposal as NodeResult<SampleOutput>;
      }finally{
        const usage=summarizeProviderDiagnostics(records),aggregate={...state.optimizerUsage};
        for(const key of Object.keys(aggregate)as(keyof typeof aggregate)[])aggregate[key]+=usage[key];
        state={...state,optimizerUsage:aggregate};await save();
      }
      if(sampled.status!=='success'||!sampled.output){
        const detail=sampled.error?.message??'Optimizer provider did not return a complete proposal';
        // Native NodeResult retains the message but can replace a thrown error code with EXECUTION_FAILED.
        const code=detail.startsWith('SEARCH_DIRECTION_BUDGET:')?'SEARCH_DIRECTION_BUDGET':detail.startsWith('SEARCH_BUDGET_EXHAUSTED:')?'SEARCH_BUDGET_EXHAUSTED':undefined;
        throw Object.assign(Error(detail),{infrastructureFailure:true,...(code?{code}:{})});
      }
      rawResponse=typeof sampled.output.message.content==='string'?sampled.output.message.content:JSON.stringify(sampled.output.message.content);
      const parsed=parseOfficialProposal(rawResponse);definition=parsed.definition;rationale=parsed.rationale;toolArtifacts=parsed.toolArtifacts;mutation=parsed.mutation;
      assertReusableStrategy(definition,options.publicTasks);
      validateOfficialChange(parent.definition,definition,mutation,parent.toolArtifacts,toolArtifacts);
      if(selection.explorationDirection)validateExploration(parent.definition,definition,selection.explorationDirection);
      const artifactHash=officialArtifactHash(definition,toolArtifacts);
      if(state.history.some(row=>row.artifactHash===artifactHash&&['valid','quality-pruned'].includes(row.status)))throw Error('Duplicate artifact; changing rationale or mutation metadata does not create a new workflow');
      state={...state,pending:{id,designRound:selection.designRound,proposalAttempt,parentId:parent.id,definition,rationale,toolArtifacts,mutation,artifactHash,rawResponse,...(selection.explorationDirection?{explorationDirection:selection.explorationDirection}:{})}};
      await save();await event({type:'unified-candidate-proposed',pending:state.pending});
    }catch(error){
      if((error as {checkpointFailure?:boolean})?.checkpointFailure)throw error;
      if((error as {code?:string})?.code==='SEARCH_DIRECTION_BUDGET'){
        const attempt:OfficialAttempt={id,designRound:selection.designRound,proposalAttempt,parentId:parent.id,status:'resource-stopped',...(selection.explorationDirection?{explorationDirection:selection.explorationDirection}:{}),publicErrors:['Protected proposal/evaluation direction quota exhausted; proceed to the next reserved direction.']};
        const{selection:_selection,...rest}=state;state={...rest,history:[...state.history,attempt],designRoundsCompleted:selection.designRound};await save();await event({type:'unified-direction-budget-stopped',attempt});continue;
      }
      const isInfrastructure=infrastructure(error),publicError=isInfrastructure?'Optimizer infrastructure interrupted the proposal; preserve its intended definition.':message(error).slice(0,1600);
      const publicIssue:DefinitionIssue=error instanceof DefinitionError?error.issue:{code:'B_PROPOSAL_CONTRACT',path:'proposal',message:publicError,repairHint:'Return a complete valid JSON proposal with the documented fields; use the specific error and retain the intended mechanism.'};
      const attempt:OfficialAttempt={id,designRound:selection.designRound,proposalAttempt,parentId:parent.id,status:isInfrastructure?'provider-error':'invalid-proposal',...(selection.explorationDirection?{explorationDirection:selection.explorationDirection}:{}),
        ...(rawResponse!==undefined?{rawResponse}:{}),...(definition?{definition,toolArtifacts,mutation,artifactHash:officialArtifactHash(definition,toolArtifacts)}:{}),...(rationale?{rationale}:{}),publicErrors:[publicError],...(!isInfrastructure?{publicIssues:[publicIssue]}:{})};
      state={...state,history:[...state.history,attempt],engineeringFailures:state.engineeringFailures+(isInfrastructure?0:1),selection:{...state.selection!,
        ...(!isInfrastructure?{contractRepair:{rejectedAttemptId:id,...(definition?{definition,toolArtifacts,mutation}:{}),...(rawResponse!==undefined?{rawResponse}:{}),
          errors:[...new Set([...(state.selection?.contractRepair?.errors??[]),publicError])],issues:[...(state.selection?.contractRepair?.issues??[]),publicIssue]}}:{})}};
      await save();await event({type:'unified-proposal-rejected',attempt});if(isInfrastructure)throw error;
    }
  }
  const best=bestOfficialCandidate(state.history);if(!best)throw Error('No complete valid candidate is available');
  return {state,best,stoppedBecause};
}

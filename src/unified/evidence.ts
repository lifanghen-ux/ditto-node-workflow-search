import type {CaseResult} from '../domain.js';
import {traceValue,selectPublicTraceEvents,publicBfclTurnEvidence,publicBfclFunctionCatalogue,type FeedbackEvaluation} from './feedback.js';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const PREDICTION_LIMIT=4000;

/** Full executions stay in JSONL. Only bounded, score-selected public views enter search state. */
export class EvaluationTraceView {
 readonly #tasks:Set<string>;
 readonly #limit:number;
 readonly #repeats:number;
 readonly #runs=new Map<string,Map<string,Record<string,unknown>>>();
 readonly #counts=new Map<string,number>();
 readonly #executed=new Set<string>();
 #modelFailure=false;
 constructor(taskIds:readonly string[],repeats:number){
  this.#tasks=new Set(taskIds);this.#repeats=Math.max(2,repeats);
  this.#limit=Math.min(8000,Math.max(512,Math.floor(2000000/Math.max(1,taskIds.length)/2)-256));
 }
 add(value:unknown):void{
  if(!object(value)||typeof value.taskId!=='string'||!this.#tasks.has(value.taskId))return;
  const count=(this.#counts.get(value.taskId)??0)+1;this.#counts.set(value.taskId,count);
  const raw=object(value.rawNodeOutputs)?value.rawNodeOutputs:{};
  for(const id of [...Object.keys(raw),...(Array.isArray(value.executedNodeIds)?value.executedNodeIds:[])])if(typeof id==='string')this.#executed.add(id);
  this.#modelFailure ||= Boolean(value.modelFailure);
  const key=typeof value.caseId==='string'?value.caseId:`legacy-run-${count}`;
  const runs=this.#runs.get(value.taskId)??new Map<string,Record<string,unknown>>();
  this.#runs.set(value.taskId,runs);
  if(!runs.has(key)&&runs.size>=this.#repeats)return;
  const events=Array.isArray(value.events)?value.events:[];
  const selected=selectPublicTraceEvents(events),causal=selected.some(event=>object(event)&&typeof event.nodeType==='string');
  const bfclTurns=publicBfclTurnEvidence(events,Math.floor(this.#limit*.6));
  const base={taskId:value.taskId,...(typeof value.caseId==='string'?{caseId:value.caseId}:{}),truncated:true,traceSelection:'action-and-outcome-window-v1'};
  let view:Record<string,unknown>={...base,events:[]};
  for(const limit of [1200,600,240,80,16]){
   const next={...base,...(bfclTurns?{bfclTurns}:{}),events:selected.map(event=>traceValue(event,limit)),
    ...(!causal&&object(value.nodeInputs)?{nodeInputs:traceValue(value.nodeInputs,limit*2)}:{}),
    ...(!causal&&object(value.rawNodeOutputs)?{rawNodeOutputs:traceValue(value.rawNodeOutputs,limit*2)}:{})};
   if(JSON.stringify(next).length<=this.#limit){view=next;break;}
  }
  const bfclFunctions=publicBfclFunctionCatalogue(events);
  runs.set(key,{...view,...(bfclFunctions?{bfclFunctions}:{})});
 }
 views(results:readonly CaseResult[]):readonly unknown[]{
  const scores=new Map(results.filter(row=>row.valid===true&&!row.error).map(row=>[row.caseId,row.score]));
  const views:unknown[]=[];
  for(const [taskId,entries]of this.#runs){
   const runs=[...entries].sort(([a],[b])=>(scores.get(a)??0)-(scores.get(b)??0)||a.localeCompare(b));
   const chosen=new Map([runs[0],runs.at(-1)].filter((row):row is [string,Record<string,unknown>]=>row!==undefined));
   for(const view of chosen.values())views.push({...view,originalTaskRuns:this.#counts.get(taskId),outcomeSelection:'lowest-and-highest-observed-score'});
  }
  // All actual executed IDs remain available for protected-worker validation,
  // including operations outside the bounded example/event selection.
  views.push({executedNodeIds:[...this.#executed],...(this.#modelFailure?{modelFailure:true}:{})});
  return views;
 }
}

/** Grade first, journal full details, then retain only a pointer to bulky private worlds/traces. */
export function boundedCaseDetails(row:CaseResult,fullCases:string):CaseResult{
 if(row.valid!==true||row.error!==undefined)return row;
 const {details,providerDiagnostics,previousResults,checkerAudits,judgeRecovery,generationOutcomes,...rest}=row;
 if(JSON.stringify({details,providerDiagnostics,previousResults,checkerAudits,judgeRecovery,generationOutcomes}).length<=32768)return row;
 return{...rest,...(row.attempts?{attempts:row.attempts.map(({providerDiagnostics:_diagnostics,...attempt})=>attempt)}:{}),
  details:{artifactProjection:{version:'external-case-details-v1',fullCases,caseId:row.caseId,predictionLength:row.prediction.length,normalizedPredictionLength:row.normalizedPrediction.length}}};
}


function selectionCase(row:CaseResult):CaseResult{
 const {details:_details,providerDiagnostics:_diagnostics,previousResults:_previous,checkerAudits:_audits,
  judgeRecovery:_recovery,attempts:_attempts,generationOutcomes:_generations,...small}=row;
 const earlier=row.details?.artifactProjection;
 const length=(key:string,fallback:number)=>object(earlier)&&typeof earlier[key]==='number'?Math.max(fallback,earlier[key]):fallback;
 return{...small,prediction:row.prediction.slice(0,PREDICTION_LIMIT),normalizedPrediction:row.normalizedPrediction.slice(0,PREDICTION_LIMIT),
  details:{artifactProjection:{version:'selection-evidence-v1',predictionLength:length('predictionLength',row.prediction.length),normalizedPredictionLength:length('normalizedPredictionLength',row.normalizedPrediction.length)}}};
}

/** Never rescore excerpts. Scores/counters are copied from already graded full answers. */
export function selectionEvaluation(summary:FeedbackEvaluation,prefix:string,publicTraces=summary.publicTraces??[]):FeedbackEvaluation{
 return{...summary,results:summary.results.map(selectionCase),publicTraces,
  artifacts:{version:'evaluation-evidence-v1',representation:'selection',fullSummary:prefix+'/summary.json',publicTraces:prefix+'/public-traces.jsonl',caseEvents:prefix+'/case-events.jsonl',predictionExcerptLimit:PREDICTION_LIMIT}};
}

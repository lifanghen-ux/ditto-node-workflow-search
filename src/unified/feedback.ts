import type {BenchmarkTask,CaseResult,EvaluationSummary} from '../domain.js';
import {publicAnswerWarnings,taskOutputRequirements} from '../benchmark/answer-contract.js';
import {publicEvaluationContract} from '../benchmark/evaluation-contract.js';
import {createHash} from 'node:crypto';
import type {DefinitionIssue} from '../graph-agent/schema.js';

export const PUBLIC_FEEDBACK_VERSION='public-runtime-feedback-v13-executable-checks';

export interface FeedbackEvaluation extends EvaluationSummary {
  /** Verified prior measurement lineage; does not change new-search root IDs. */
  readonly comparisonParentId?:string;
  readonly qualityPruned?:boolean;
  readonly stage?:number;
  readonly publicTraces?:readonly unknown[];
  readonly engineeringIssues?:readonly {readonly code:string;readonly message:string}[];
  readonly artifacts?:{readonly version:'evaluation-evidence-v1';readonly representation:'full-results'|'selection';readonly fullSummary:string;readonly publicTraces:string;readonly caseEvents:string;readonly predictionExcerptLimit:number};
}
export interface FeedbackRecord {
  readonly id:string;
  readonly parentId:string|null;
  readonly status:string;
  readonly rationale?:string;
  readonly evaluation?:FeedbackEvaluation;
  /** Application-owned public contract errors only; never CaseResult.error. */
  readonly publicErrors?:readonly string[];
  readonly publicIssues?:readonly DefinitionIssue[];
}

const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const mean=(values:readonly number[]):number|null=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const clipped=(text:string,maximum:number)=>({text:text.slice(0,maximum),truncated:text.length>maximum,originalLength:text.length});
const sensitive=(key:string)=>/(?:secret|password|credential|apikey|authorization)/i.test(key)
  || /^(?:expected|normalizedexpected|reference|referenceanswer|references|gold|goldanswer|labels?|testsource|assertions?|private.*)$/i.test(key.replace(/[^a-z0-9]/gi,''));

function promptSnippet(text:string,maximum:number){
  if(text.length<=maximum)return clipped(text,maximum);
  const marker='\n[...truncated...]\n',available=maximum-marker.length,tail=Math.min(available,Math.max(500,Math.floor(available*.45)));
  return {text:text.slice(0,available-tail)+marker+text.slice(-tail),truncated:true,originalLength:text.length};
}

/** Trace values originate in runtime nodes; strip even accidentally attached scorer/secret fields. */
export function traceValue(value:unknown,maximum=1200,maximumDepth=8):unknown {
  let remaining=maximum;
  const seen=new Set<object>();
  function visit(item:unknown,depth:number,observation=false):unknown {
    if(remaining<=0)return '[truncated]';
    if(typeof item==='string'){const text=item.slice(0,remaining);remaining-=text.length;return text;}
    if(item===null||typeof item==='boolean'||finite(item))return item;
    if(depth>maximumDepth||typeof item!=='object'||item===null)return '[omitted]';
    if(seen.has(item))return '[cycle]';seen.add(item);
    if(Array.isArray(item))return item.slice(0,30).map(child=>visit(child,depth+1,observation));
    // Native registered-tool results carry public business errors. Arbitrary
    // runtime/scorer error fields remain excluded from optimizer evidence.
    const native=isObject(item)&&typeof item.callId==='string'&&typeof item.source==='string'
      &&['success','failed','cancelled','timeout','unknown'].includes(String(item.status));
    const toolEvent=typeof (item as any).nodeType==='string'&&(item as any).nodeType==='INTERACTION.ACT.TOOL';
    const pythonArguments=typeof (item as any).source==='string'&&typeof (item as any).entryPoint==='string'&&typeof (item as any).checks==='string';
    const result:Record<string,unknown>={};
    const priority=(key:string)=>native?(['callId','source','status','error','structuredContent','message','content'].indexOf(key)+1||100)
      :toolEvent?(['graphId','nodeId','nodeType','publicDiagnostics','output','input'].indexOf(key)+1||100)
      :pythonArguments?(['entryPoint','checks','source'].indexOf(key)+1||100)
      :observation?(['completionCheck','error','executionEvidence','turn','complete'].indexOf(key)+1||100):100;
    // Native tools often repeat structured data as a long rendered content
    // string. Reserve the useful structured/error evidence before that copy.
    const entries=Object.entries(item).sort(([a],[b])=>priority(a)-priority(b));
    for(const [key,child]of entries.slice(0,40)){
      if(sensitive(key)||(key==='error'&&!observation&&!native)||key==='previousResults')continue;
      const publicChild=observation||(native&&['content','structuredContent','message','error'].includes(key));
      result[key]=visit(child,depth+1,publicChild);
    }
    return result;
  }
  return visit(value,0);
}

/** Bounded causal examples; original indexes survive selection and serialization. */
export function selectPublicTraceEvents(events:readonly unknown[]):readonly unknown[]{
  const selected=new Set<number>();
  const add=(index:number)=>{if(index>=0&&index<events.length&&selected.size<6)selected.add(index);};
  const tool=(event:unknown)=>isObject(event)&&(event.nodeType==='INTERACTION.ACT.TOOL'
    ||(event.nodeType===undefined&&isObject(event.output)&&typeof event.output.callId==='string'&&typeof event.output.source==='string'));
  add(0);add(events.length-1);
  // A node can produce a correct artifact that a later Loop assignment discards.
  // Keep that actual boundary and its preceding Graph result, not just tools.
  for(let i=events.length-1;i>=0;i--){
    const event=events[i];
    if(isObject(event)&&event.nodeType==='HOST.LOOP.BOUNDARY'&&Array.isArray(event.publicDiagnostics)&&event.publicDiagnostics.length){add(i);add(i-1);break;}
  }
  // An early failed executable check must survive later successful fallback,
  // bookkeeping and turn submission events in the bounded causal window.
  for(let i=events.length-1;i>=0;i--){
    const event=events[i];
    if(tool(event)&&isObject(event)&&Array.isArray(event.publicDiagnostics)&&event.publicDiagnostics.length){add(i);add(i-1);break;}
  }
  const distinct:number[]=[],repeated:number[]=[],sources=new Set<string>();
  for(let i=events.length-1;i>=0;i--){
    if(!tool(events[i]))continue;
    const event=events[i] as Record<string,unknown>,input=isObject(event.input)?event.input:{},call=isObject(input.call)?input.call:{};
    const source=String(call.name??(isObject(event.output)?event.output.source:undefined)??event.nodeId??i);
    (sources.has(source)?repeated:distinct).push(i);sources.add(source);
  }
  // Repeated final replies must not crowd out the last use of another tool.
  for(const i of [...distinct,...repeated]){
    if(selected.size>=6)break;
    add(i);
    for(let j=i-1;j>=0;j--){
      const event=events[j];if(tool(event))break;
      if(isObject(event)&&typeof event.nodeType==='string'&&event.nodeType.startsWith('INFER.REASONING.')){add(j);break;}
    }
  }
  for(let i=events.length-2;i>=0&&selected.size<6;i--)add(i);
  return [...selected].sort((a,b)=>a-b).map(index=>{
    const event=events[index];
    if(!isObject(event))return event;
    const {eventIndex,...fields}=event;
    return {eventIndex:finite(eventIndex)?eventIndex:index,...fields};
  });
}

/** Public BFCL requests and actual calls, grouped before the event window drops
 * middle turns. No checker diagnosis or guessed failing turn is consulted. */
export function publicBfclTurnEvidence(events:readonly unknown[],maximum=4000):unknown|undefined {
 const turns=new Map<number,{turn:number;request:unknown;actions:Record<string,unknown>[];submissions:number;rejectedSubmissions:number}>(),functions=new Set<string>();
 const execution:unknown[]=[];
 const row=(turn:number)=>{if(!turns.has(turn))turns.set(turn,{turn,request:null,actions:[],submissions:0,rejectedSubmissions:0});return turns.get(turn)!;};
 for(const event of events){
  if(!isObject(event)||!isObject(event.input)||!isObject(event.input.call)||!isObject(event.output))continue;
  const call=event.input.call,output=event.output,body=output.structuredContent;
  if(!['bfcl_state','bfcl_call','bfcl_respond'].includes(String(call.name))||output.source!==call.name||!isObject(body))continue;
  const args=isObject(call.arguments)?call.arguments:{};
  if(Number.isSafeInteger(args.turn)&&['bfcl_call','bfcl_respond'].includes(String(call.name))){
   // Arguments and turn boundaries are scored behavior; a reply's wording is
   // deliberately excluded. Hash before display clipping, never from labels.
   const accepted=body.error===undefined&&(call.name==='bfcl_call'?Array.isArray(body.observations)&&Array.isArray(args.calls)&&body.observations.length===args.calls.length
    :body.turn===(args.turn as number)+1&&Array.isArray(body.history));
   execution.push({turn:args.turn,tool:call.name,status:accepted?'executed':'rejected',...(call.name==='bfcl_call'?{calls:args.calls}:{})});
   const shapes=Array.isArray(body.observationShapes)?body.observationShapes.filter(isObject).map(shape=>({function:shape.function,format:shape.format,
    observed:isObject(shape.observed)?shape.observed.kind:undefined,declared:shape.declaredKind,mismatch:shape.schemaShapeMismatch})):[];
   if(call.name==='bfcl_respond'){if(accepted)row(args.turn as number).submissions++;else row(args.turn as number).rejectedSubmissions++;}
   else row(args.turn as number).actions.push({status:accepted?'executed':'rejected',calls:traceValue(args.calls,1000),shapes,
    ...(typeof body.error==='string'?{publicError:body.error.slice(0,400)}:{}),observations:traceValue(body.observations,400)});
  }
  if(Number.isSafeInteger(body.turn)&&body.complete!==true&&Array.isArray(body.history)){
   const lastUser=body.history.findLastIndex(message=>isObject(message)&&message.role==='user');
   if(lastUser>=0){const message=body.history[lastUser];if(isObject(message))row(body.turn as number).request=traceValue({role:'user',content:message.content},1600);}
  }
  if(Array.isArray(body.functions))for(const fn of body.functions)if(isObject(fn)&&typeof fn.name==='string')functions.add(fn.name);
 }
 if(!turns.size)return undefined;
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):isObject(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const executionFingerprint=createHash('sha256').update(JSON.stringify(canonical(execution))).digest('hex');
 const all=[...turns.values()].sort((a,b)=>a.turn-b.turn),selected=all.slice(0,8);
 for(const requestLimit of [1000,600,240,100,32])for(const limit of [1000,500,240,100,32]){
  const value={source:'public-tool-turns',executionFingerprint,availableFunctionNames:[...functions].slice(0,100),originalTurns:all.length,
   turns:selected.map(turn=>({...turn,request:traceValue(turn.request,requestLimit),originalActions:turn.actions.length,
    actions:[...new Set([0,...turn.actions.map((_,i)=>i).slice(-5)])].filter(i=>i<turn.actions.length).map(i=>({actionIndex:i,
     status:turn.actions[i]!.status,calls:traceValue(turn.actions[i]!.calls,limit),shapes:turn.actions[i]!.shapes,...(turn.actions[i]!.publicError?{publicError:turn.actions[i]!.publicError}:{}),observations:traceValue(turn.actions[i]!.observations,Math.min(limit,120))}))})),
   truncated:all.length>8||selected.some(turn=>turn.actions.length>6)||limit<1000||requestLimit<1000};
  if(JSON.stringify(value).length<=maximum)return value;
 }
 return {source:'public-tool-turns',executionFingerprint,originalTurns:all.length,turns:selected.map(turn=>({turn:turn.turn,request:traceValue(turn.request,32),
  submissions:turn.submissions,originalActions:turn.actions.length})),truncated:true};
}

/** Compact public function declarations, not inferred actions or checker hints.
 * Keep these separately: long business observations must not erase the API. */
export function publicBfclFunctionCatalogue(events:readonly unknown[],maximum=7000):unknown|undefined {
 const functions=new Map<string,Record<string,unknown>>(),used=new Set<string>();
 // The schema is public API evidence. Its descriptions carry units and update
 // semantics that cannot be reconstructed from parameter names and types.
 const schema=(value:unknown,descriptionLimit:number,depth=0):Record<string,unknown>=>{
  if(!isObject(value)||depth>2)return{};
  const out:Record<string,unknown>={};
  for(const key of ['type','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minItems','maxItems','minLength','maxLength'])
   if(typeof value[key]==='string'||finite(value[key]))out[key]=value[key];
  if(typeof value.description==='string'){
   out.description=value.description.slice(0,descriptionLimit);
   if(value.description.length>descriptionLimit)out.descriptionTruncated=true;
  }
  if(Array.isArray(value.enum))out.enum=traceValue(value.enum,300);
  if(Object.hasOwn(value,'default'))out.default=traceValue(value.default,200);
  if(Array.isArray(value.required))out.required=value.required.filter(key=>typeof key==='string');
  if(isObject(value.properties))out.properties=Object.fromEntries(Object.entries(value.properties).slice(0,30).map(([key,child])=>{
   const declaration=schema(child,descriptionLimit,depth+1);
   if(sensitive(key))delete declaration.default;
   return[key,declaration];
  }));
  if(isObject(value.items))out.items=schema(value.items,descriptionLimit,depth+1);
  return out;
 };
 for(const event of events){
  if(!isObject(event)||!isObject(event.output)||!['bfcl_state','bfcl_call','bfcl_respond'].includes(String(event.output.source)))continue;
  const call=isObject(event.input)&&isObject(event.input.call)?event.input.call:undefined;
  if(event.output.source==='bfcl_call'&&call?.name==='bfcl_call'&&isObject(call.arguments)&&Array.isArray(call.arguments.calls))
   for(const action of call.arguments.calls)if(isObject(action)&&typeof action.name==='string')used.add(action.name);
  const body=event.output.structuredContent;if(!isObject(body)||!Array.isArray(body.functions))continue;
  for(const fn of body.functions)if(isObject(fn)&&typeof fn.name==='string'){
   functions.set(fn.name,fn);
  }
 }
 if(!functions.size)return undefined;
 const kept:Record<string,unknown>[]=[];
 const envelope=(entries:Record<string,unknown>[],truncated:boolean)=>({source:'public-function-declarations',selection:'observed-business-calls-first',functions:entries,originalFunctions:functions.size,truncated});
 // Observation order is evidence, not a recommendation. Unused declarations
 // must not crowd a function actually involved in the measured execution out.
 const ordered=[...functions.values()].sort((a,b)=>Number(used.has(String(b.name)))-Number(used.has(String(a.name))));
 for(const fn of ordered){
  for(const limit of [240,100,40]){
   const parameters=schema(fn.parameters,limit),response=schema(fn.response,limit);
   const entry={name:fn.name,description:typeof fn.description==='string'?fn.description.split('Tool description:').at(-1)!.trim().slice(0,limit):'',
    required:parameters.required??[],parameters:parameters.properties??{},...(Object.keys(response).length?{response}:{}),...(limit<240?{schemaTruncated:true}:{})};
   if(JSON.stringify(envelope([...kept,entry],true)).length<=maximum){kept.push(entry);break;}
  }
 }
 return envelope(kept,kept.length<functions.size||kept.some(fn=>fn.schemaTruncated===true));
}

function validRows(record:FeedbackRecord,publicTasks:ReadonlyMap<string,BenchmarkTask>):Map<string,CaseResult>{
  const rows=new Map<string,CaseResult>();
  for(const row of record.evaluation?.results??[]){
    const taskId=row.caseId.replace(/#[1-9]\d*$/,'');
    if(!publicTasks.has(taskId)||row.valid!==true||row.error!==undefined||row.candidateFailure!==undefined||!finite(row.score)||row.score<0||row.score>1||typeof row.prediction!=='string')continue;
    rows.set(row.caseId,row);
  }
  return rows;
}

function publicTrace(record:FeedbackRecord,taskId:string){
  const runs=(record.evaluation?.publicTraces??[]).filter(value=>isObject(value)&&value.taskId===taskId);
  const selected=runs.slice(0,2).map(value=>{
    const run=value as Record<string,unknown>;
    const events=Array.isArray(run.events)?run.events:Array.isArray(run.trace)?run.trace:[];
    const selected=selectPublicTraceEvents(events),causal=selected.some(event=>isObject(event)&&typeof event.nodeType==='string');
    return {events:selected.map(event=>traceValue(event)),
      ...(run.bfclTurns?{bfclTurns:traceValue(run.bfclTurns,6000,14)}:{}),
      ...(run.bfclFunctions?{bfclFunctions:traceValue(run.bfclFunctions,8000,14)}:{}),
      ...(!causal&&isObject(run.nodeInputs)?{nodeInputs:traceValue(run.nodeInputs,2000)}:{}),
      ...(!causal&&isObject(run.rawNodeOutputs)?{rawNodeOutputs:traceValue(run.rawNodeOutputs,2000)}:{}),
      ...(typeof run.caseId==='string'?{caseId:run.caseId}:{}),
      ...(typeof run.traceSelection==='string'?{selection:run.traceSelection}:{}),
      truncated:events.length>6||run.truncated===true};
  });
  const originalRuns=Math.max(runs.length,...runs.map(run=>isObject(run)&&finite(run.originalTaskRuns)?run.originalTaskRuns:0));
  return {source:'public-runtime-events',runs:selected,originalRuns,truncated:originalRuns>selected.length||selected.some(run=>run.truncated)};
}

function executionComparison(record:FeedbackRecord,taskId:string,history:readonly FeedbackRecord[]){
 const signatures=(candidate:FeedbackRecord)=>(candidate.evaluation?.publicTraces??[]).flatMap(value=>{
  if(!isObject(value)||value.taskId!==taskId||typeof value.caseId!=='string'||!isObject(value.bfclTurns)
   ||typeof value.bfclTurns.executionFingerprint!=='string')return[];
  return[{caseId:value.caseId,fingerprint:value.bfclTurns.executionFingerprint}];
 });
 const current=signatures(record);if(!current.length)return undefined;
 const matches=history.filter(other=>other.id!==record.id&&other.status==='valid').flatMap(other=>
  signatures(other).filter(signature=>current.some(run=>run.caseId===signature.caseId&&run.fingerprint===signature.fingerprint))
   .map(signature=>({candidateId:other.id,caseId:signature.caseId}))).slice(0,12);
 return{source:'actual-official-action-sequence',sameSequenceAs:matches,
  meaning:'Matches have identical requested business function names, arguments, accepted/rejected action status and accepted turn submission boundaries on these case IDs. Rejected requests are not successful business executions. Reply wording and transform nodes are excluded. This is behavioral evidence, not proof of correctness, equal observations or equal world state.'};
}

function predictionSnippet(row:CaseResult,limit:number){
 const part=clipped(row.prediction,limit),projection=row.details?.artifactProjection;
 if(isObject(projection)&&finite(projection.predictionLength))return{...part,originalLength:projection.predictionLength,truncated:part.truncated||projection.predictionLength>row.prediction.length};
 return part;
}

export interface FeedbackOptions {
  readonly maxCandidates?:number;
  readonly maxCases?:number;
  readonly maxCharacters?:number;
  /** Rotate public failures across search rounds instead of showing the same six forever. */
  readonly failureOffset?:number;
}

/** Never spread/stringify CaseResult: expected/normalizedExpected carry private labels. */
export function buildUnifiedFeedback(history:readonly FeedbackRecord[],tasks:readonly BenchmarkTask[],options:FeedbackOptions={}){
  const maxCandidates=options.maxCandidates??8,maxCases=options.maxCases??6,maxCharacters=options.maxCharacters??60000;
  const failureOffset=options.failureOffset??0;
  if(!Number.isSafeInteger(failureOffset)||failureOffset<0)throw Error('Invalid feedback failure offset');
  if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>40||!Number.isSafeInteger(maxCases)||maxCases<0||maxCases>6
    ||!Number.isSafeInteger(maxCharacters)||maxCharacters<6000||maxCharacters>200000)throw Error('Invalid public feedback bounds');
  const taskMap=new Map(tasks.map(task=>[task.id,task])),byId=new Map(history.map(row=>[row.id,row]));
  const ranked=history.filter(row=>row.status==='valid').sort((a,b)=>(b.evaluation?.score??0)-(a.evaluation?.score??0));
  const chosen=[...new Map([...history.slice(-Math.max(1,maxCandidates-4)),...ranked.slice(0,Math.min(4,maxCandidates))].map(row=>[row.id,row])).values()].slice(-maxCandidates);
  const assembled=chosen.map(record=>{
    const rows=validRows(record,taskMap),referenceId=record.parentId??record.evaluation?.comparisonParentId;
    const reference=referenceId?byId.get(referenceId):undefined;
    const prior=reference?validRows(reference,taskMap):new Map<string,CaseResult>();
    const common=[...rows.values()].filter(row=>prior.has(row.caseId));
    const groups=new Map<string,CaseResult[]>();
    for(const row of rows.values()){const taskId=row.caseId.replace(/#[1-9]\d*$/,'');groups.set(taskId,[...(groups.get(taskId)??[]),row]);}
    const cases=[...groups].map(([taskId,outcomes])=>({taskId,outcomes,score:mean(outcomes.map(row=>row.score))!,
      delta:mean(outcomes.filter(row=>prior.has(row.caseId)).map(row=>row.score-prior.get(row.caseId)!.score))}));
    const selected:typeof cases=[];const ids=new Set<string>();
    const add=(item:typeof cases[number]|undefined)=>{if(item&&!ids.has(item.taskId)&&selected.length<maxCases){ids.add(item.taskId);selected.push(item);}};
    add(cases.filter(row=>row.delta!==null&&row.delta<0).sort((a,b)=>a.delta!-b.delta!)[0]);
    add([...cases].sort((a,b)=>a.score-b.score||a.taskId.localeCompare(b.taskId))[0]);
    add(cases.filter(row=>row.delta!==null&&row.delta>0).sort((a,b)=>b.delta!-a.delta!)[0]);
    add(cases.find(row=>row.score===1&&row.delta===0)??cases.find(row=>row.score===1));
    // Fresh regressions are more actionable than unchanged failures. Keep all
    // that fit after the improvement and successful control, before rotation.
    for(const item of cases.filter(row=>row.delta!==null&&row.delta<0).sort((a,b)=>a.delta!-b.delta!))add(item);
    const failures=cases.filter(row=>row.score<1).sort((a,b)=>a.score-b.score||a.taskId.localeCompare(b.taskId));
    const offset=failures.length?failureOffset%failures.length:0;
    for(const item of [...failures.slice(offset),...failures.slice(0,offset),...cases])add(item);
    const evaluation=record.evaluation;
    const feedback={id:record.id,parentId:record.parentId,status:record.status,rationale:clipped(record.rationale??'',1000),rationaleStatus:'unverified-optimizer-hypothesis; measured events and scores are authoritative',
      measurement:{scope:record.status==='valid'?'complete-prescribed-evaluation':'partial-or-unavailable',stage:evaluation?.stage??evaluation?.examples??null,
        observedTasks:groups.size,observedValidRuns:rows.size,declaredRepeats:evaluation?.repeats??null,
        fullScore:record.status==='valid'&&evaluation?.valid===true?evaluation.score:null,
        stageScore:evaluation?.valid===true?mean([...rows.values()].map(row=>row.score)):null},
      paired:{referenceId:reference?.id??null,scope:'common-valid-caseIds-only',overlapRuns:common.length,
        meanScoreDelta:mean(common.map(row=>row.score-prior.get(row.caseId)!.score)),
        improvedTasks:cases.filter(row=>row.delta!==null&&row.delta>1e-12).length,
        regressedTasks:cases.filter(row=>row.delta!==null&&row.delta< -1e-12).length,
        unchangedTasks:cases.filter(row=>row.delta!==null&&Math.abs(row.delta)<=1e-12).length},
      cost:{scope:'candidate-execution-excludes-optimizer',inputTokens:evaluation?.inputTokens??null,outputTokens:evaluation?.outputTokens??null,
        totalTokens:evaluation?.totalTokens??null,providerAttempts:evaluation?.providerAttemptCount??null,durationMs:evaluation?.durationMs??null,
        usageStatus:evaluation?.tokenUsageStatus??'unknown'},
      cases:selected.map((item,index)=>({taskId:item.taskId,prompt:promptSnippet(taskMap.get(item.taskId)!.prompt,12000),
        ...(taskMap.get(item.taskId)!.dataset==='bfcl'?{executionComparison:executionComparison(record,item.taskId,history)}:{}),
        outputInstruction:clipped(taskOutputRequirements(taskMap.get(item.taskId)!),2600),pairedDelta:item.delta,
        outcomes:item.outcomes.slice(0,5).map(row=>({caseId:row.caseId,score:row.score,prediction:predictionSnippet(row,['mbpp','humaneval'].includes(taskMap.get(item.taskId)!.dataset)?4000:1200),
          answerContractWarnings:predictionSnippet(row,Number.MAX_SAFE_INTEGER).truncated?[]:publicAnswerWarnings(taskMap.get(item.taskId)!,row.prediction),
          parentOutcome:prior.has(row.caseId)?{candidateId:reference!.id,score:prior.get(row.caseId)!.score,prediction:predictionSnippet(prior.get(row.caseId)!,['mbpp','humaneval'].includes(taskMap.get(item.taskId)!.dataset)?4000:1200)}:null})),
        outcomesTruncated:item.outcomes.length>5,...(index<3?{trace:publicTrace(record,item.taskId)}:{traceOmitted:true})})),
      engineering:{publicContractErrors:(record.publicErrors??[]).slice(-5).map(message=>clipped(message,700)),
        contractIssues:(record.publicIssues??[]).slice(-5).map(issue=>({code:issue.code,path:issue.path,message:clipped(issue.message,700),repairHint:clipped(issue.repairHint,700)})),
        issues:(evaluation?.engineeringIssues??[]).slice(0,5).map(issue=>({code:issue.code,message:clipped(issue.message,700)}))},
      truncation:{casesOmitted:Math.max(0,cases.length-selected.length),traceCaseLimit:3,budgetClipped:false},
    };
    return feedback;
  });
  type Feedback=typeof assembled[number];
  type Snippet=ReturnType<typeof clipped>;
  const resize=(part:Snippet,limit:number,preserveTail=false):Snippet=>{
    const shortened=preserveTail?promptSnippet(part.text,limit):clipped(part.text,limit);
    return{...shortened,originalLength:part.originalLength,truncated:part.truncated||shortened.truncated};
  };
  // The envelope, including omission metadata, shares the same hard character cap.
  const packet=(feedback:readonly Feedback[])=>{
    const included=new Set(feedback.map(row=>row.id)),omitted=history.filter(row=>!included.has(row.id));
    const listed=omitted.slice(0,Math.min(64,Math.floor(maxCharacters/600)));
    return{source:PUBLIC_FEEDBACK_VERSION,...(tasks[0]?{evaluationContract:publicEvaluationContract(tasks[0].dataset)}:{}),scoreInterpretation:'Scores and parentOutcome are measured candidate outputs, not reference answers. A low text-F1 score does not identify a reasoning error. Check the actual computation and requested answer type; contract warnings are observable hints, not gold-derived root-cause labels.',
      candidateCount:history.length,feedback,omittedCandidateCount:omitted.length,
      omittedCandidateIds:listed.map(row=>row.id.slice(0,120)),
      omittedCandidateIdsTruncated:listed.length<omitted.length||listed.some(row=>row.id.length>120),
      truncated:omitted.length>0||feedback.some(row=>row.truncation.budgetClipped||row.truncation.casesOmitted>0||row.rationale.truncated),maxCharacters};
  };
  const size=(feedback:readonly Feedback[])=>JSON.stringify(packet(feedback)).length;
  const packed:Feedback[]=[];
  // Reserve measurements and recent public repair diagnostics before any trace.
  // A large earlier candidate cannot suppress every later candidate's summary.
  for(const full of assembled){
    const core:Feedback={...full,rationale:resize(full.rationale,200),cases:[],
      engineering:{publicContractErrors:full.engineering.publicContractErrors.slice(-2).map(x=>resize(x,220)),
        contractIssues:full.engineering.contractIssues.slice(-2).map(x=>({...x,code:x.code.slice(0,120),path:x.path.slice(0,200),message:resize(x.message,220),repairHint:resize(x.repairHint,220)})),
        issues:full.engineering.issues.slice(-2).map(x=>({...x,code:x.code.slice(0,120),message:resize(x.message,220)}))},
      truncation:{...full.truncation,casesOmitted:full.truncation.casesOmitted+full.cases.length,budgetClipped:true}};
    if(size([...packed,core])<=maxCharacters){packed.push(core);continue;}
    const minimum:Feedback={...core,rationale:resize(full.rationale,0),
      engineering:{publicContractErrors:core.engineering.publicContractErrors.slice(-1),contractIssues:core.engineering.contractIssues.slice(-1),issues:core.engineering.issues.slice(-1)}};
    if(size([...packed,minimum])<=maxCharacters)packed.push(minimum);
  }
  const replace=(index:number,value:Feedback)=>packed.map((row,i)=>i===index?value:row);
  let remainingDetails=packed.filter(row=>assembled.find(full=>full.id===row.id)!.cases.length>0).length;
  for(let i=0;i<packed.length;i++){
    const full=assembled.find(row=>row.id===packed[i]!.id)!;
    if(!full.cases.length)continue;
    const start=size(packed),share=Math.floor((maxCharacters-start)/remainingDetails--);
    const fits=(value:Feedback)=>{const length=size(replace(i,value));return length<=maxCharacters&&length-start<=share;};
    if(fits(full)){packed[i]=full;continue;}
    for(const detail of full.cases){
      const plain={taskId:detail.taskId,prompt:detail.prompt,outputInstruction:detail.outputInstruction,pairedDelta:detail.pairedDelta,
        outcomes:detail.outcomes,outcomesTruncated:detail.outcomesTruncated,traceOmitted:true};
      const compact={...plain,prompt:resize(detail.prompt,2000,true),outputInstruction:resize(detail.outputInstruction,1200),
        outcomes:detail.outcomes.map(row=>({...row,prediction:resize(row.prediction,120),
          parentOutcome:row.parentOutcome?{...row.parentOutcome,prediction:resize(row.parentOutcome.prediction,120)}:null}))};
      for(const variant of [detail,plain,compact]){
        const current=packed[i]!;
        const next:Feedback={...current,cases:[...current.cases,variant],
          truncation:{...current.truncation,casesOmitted:current.truncation.casesOmitted-1}};
        if(fits(next)){packed[i]=next;break;}
      }
    }
    const enriched:Feedback={...packed[i]!,rationale:full.rationale,engineering:full.engineering};
    if(fits(enriched))packed[i]=enriched;
  }
  return packet(packed);
}

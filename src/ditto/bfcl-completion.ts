import type {JsonObject,JsonValue} from '@codesoul-co/ditto/contracts';
import {CHECK_RELATIONS,comparePublicValues,publicPointer,PublicCheckInputError} from './public-checks.js';

export const BFCL_COMPLETION_CHECKS_SCHEMA={type:'array',minItems:1,maxItems:32,items:{type:'object',properties:{
 id:{type:'string',minLength:1,maxLength:128},callIndex:{type:'integer',minimum:0},path:{type:'string',maxLength:512},relation:{enum:CHECK_RELATIONS},target:{},
},required:['id','callIndex','path','relation','target'],additionalProperties:false}};
type Observation={callIndex:number;function:string;value:unknown};

/** A turn-local ledger of real public business observations. Targets come from
 * the workflow; the host never infers a task answer or inspects private state. */
export class BfclCompletionLedger{
 private readonly turns=new Map<number,Observation[]>();
 record(args:JsonObject,result:Record<string,unknown>):JsonObject|undefined{
  if(!Number.isSafeInteger(args.turn)||!Array.isArray(args.calls)||!Array.isArray(result.observations)||args.calls.length!==result.observations.length)return;
  const turn=Number(args.turn),rows=this.turns.get(turn)??[];
  const added=args.calls.map((call,index)=>{
   const raw=(result.observations as unknown[])[index];let value=raw;
   if(typeof raw==='string'){try{value=JSON.parse(raw);}catch{/* Preserve non-JSON results exactly. */}}
   const entry={callIndex:rows.length+index,function:String((call as JsonObject).name),value};return entry;
  });
  rows.push(...added);this.turns.set(turn,rows);
  return {turn,calls:added as unknown as JsonValue};
 }
 check(turn:unknown,checks:unknown):JsonObject{
  if(!Number.isSafeInteger(turn)||!Array.isArray(checks)||checks.length<1||checks.length>32)throw new PublicCheckInputError('completionChecks requires 1..32 checks and an integer turn');
  if(JSON.stringify(checks).length>32768)throw new PublicCheckInputError('completionChecks exceeds 32768 characters');
  const ids=new Set<string>(),rows=this.turns.get(Number(turn))??[];
  const results=checks.map(check=>{
   if(!check||typeof check!=='object'||Array.isArray(check)||Object.keys(check).length!==5||!['id','callIndex','path','relation','target'].every(key=>Object.hasOwn(check,key))
    ||typeof check.id!=='string'||!check.id.length||check.id.length>128||ids.has(check.id)||!Number.isSafeInteger(check.callIndex)||check.callIndex<0||typeof check.path!=='string'||check.path.length>512
    ||!(CHECK_RELATIONS as readonly unknown[]).includes(check.relation))throw new PublicCheckInputError('Each completion check requires a unique id, nonnegative callIndex, JSON Pointer path, relation and target');
   ids.add(check.id);const observed=rows[check.callIndex];
   if(!observed)return{id:check.id,passed:false,issue:'NO_CURRENT_TURN_OBSERVATION',callIndex:check.callIndex,path:check.path};
   if(check.callIndex!==rows.length-1)return{id:check.id,passed:false,issue:'STALE_OBSERVATION: a later business call may have changed state; obtain a final readback before submitting',callIndex:check.callIndex,path:check.path};
   try{
    const actual=publicPointer(observed.value,check.path) as JsonValue;
    return{id:check.id,passed:comparePublicValues(actual,check.target,check.relation),callIndex:check.callIndex,function:observed.function,path:check.path,actual,target:check.target as JsonValue,relation:check.relation};
   }catch(error){if(!(error instanceof PublicCheckInputError))throw error;return{id:check.id,passed:false,issue:error.message,callIndex:check.callIndex,path:check.path};}
  });
  return{passed:results.every(result=>result.passed),checks:results as JsonValue,scope:'Compared workflow-declared targets with real observations in this turn. Task interpretation, target completeness and later state changes are not certified.'};
 }
}

import {isDeepStrictEqual} from 'node:util';
import type {JsonObject,JsonValue} from '@codesoul-co/ditto/contracts';

export class PublicCheckInputError extends Error {}
export const CHECK_RELATIONS=['equal','not_equal','lt','lte','gt','gte','set_equal'] as const;
export const PUBLIC_CHECK_INPUT_SCHEMA={type:'object',properties:{
 operation:{enum:['compare','select'],description:'compare requires actual, target and relation. select requires rows; filter/order/rank are optional. selection checks the complete selected ID set.'},relation:{enum:CHECK_RELATIONS},actual:{},target:{},
 rows:{type:'array',minItems:1,maxItems:256,items:{type:'object',properties:{id:{type:'string',minLength:1,maxLength:256},value:{type:'number'}},required:['id','value'],additionalProperties:false}},
 filter:{type:'object',properties:{relation:{enum:['lt','lte','gt','gte','equal','not_equal']},value:{type:'number'}},required:['relation','value'],additionalProperties:false},
 order:{enum:['ascending','descending']},rank:{type:'integer',minimum:1},
 selection:{type:'array',maxItems:256,items:{type:'string'}},
},required:['operation'],additionalProperties:false};
export const PUBLIC_CHECK_OUTPUT_SCHEMA={type:'object',properties:{checked:{type:'boolean'},passed:{type:['boolean','null']},result:{},scope:{type:'string'}},required:['checked','passed','result','scope'],additionalProperties:false};

const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function keys(value:Record<string,unknown>,allowed:readonly string[],required:readonly string[]):void{
 if(Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw new PublicCheckInputError(`Expected fields ${required.join(', ')}; allowed fields ${allowed.join(', ')}`);
}
function number(value:unknown):asserts value is number{if(typeof value!=='number'||!Number.isFinite(value))throw new PublicCheckInputError('Comparison values must be finite numbers; strings are not coerced');}

/** Checks supplied public values, never hidden state, task meaning or a reference answer. */
export function comparePublicValues(actual:unknown,expected:unknown,relation:unknown):boolean{
 if(relation==='equal')return isDeepStrictEqual(actual,expected);
 if(relation==='not_equal')return !isDeepStrictEqual(actual,expected);
 if(relation==='set_equal'){
  if(!Array.isArray(actual)||!Array.isArray(expected))throw new PublicCheckInputError('set_equal requires two arrays');
  if(actual.length>256||expected.length>256)throw new PublicCheckInputError('set_equal supports at most 256 elements');
  return actual.every(a=>expected.some(b=>isDeepStrictEqual(a,b)))&&expected.every(b=>actual.some(a=>isDeepStrictEqual(a,b)));
 }
 if(!['lt','lte','gt','gte'].includes(String(relation)))throw new PublicCheckInputError('Unknown comparison relation');
 number(actual);number(expected);
 return relation==='lt'?actual<expected:relation==='lte'?actual<=expected:relation==='gt'?actual>expected:actual>=expected;
}

export function checkPublicData(args:JsonObject):JsonObject{
 if(JSON.stringify(args).length>65536)throw new PublicCheckInputError('Public check input exceeds 65536 characters');
 const scope='Only the supplied values and declared rule were checked. Extraction, task interpretation and completeness of source evidence remain unverified.';
 if(args.operation==='compare'){
  keys(args,['operation','actual','target','relation'],['operation','actual','target','relation']);
  return {checked:true,passed:comparePublicValues(args.actual,args.target,args.relation),result:{actual:args.actual!,target:args.target!,relation:args.relation!},scope};
 }
 if(args.operation!=='select')throw new PublicCheckInputError('operation must be compare or select');
 keys(args,['operation','rows','filter','order','rank','selection'],['operation','rows']);
 if(!Array.isArray(args.rows)||args.rows.length<1||args.rows.length>256)throw new PublicCheckInputError('rows must contain 1..256 records');
 const seen=new Set<string>();
 let rows=args.rows.map(row=>{
  if(!record(row))throw new PublicCheckInputError('Each row must be an object');
  keys(row,['id','value'],['id','value']);
  if(typeof row.id!=='string'||!row.id.length||row.id.length>256||seen.has(row.id))throw new PublicCheckInputError('Row IDs must be unique nonempty strings up to 256 characters');
  number(row.value);seen.add(row.id);return{id:row.id,value:row.value};
 });
 if(args.filter!==undefined){
  const filter=args.filter;if(!record(filter))throw new PublicCheckInputError('filter must be an object');
  keys(filter,['relation','value'],['relation','value']);number(filter.value);
  if(!['lt','lte','gt','gte','equal','not_equal'].includes(String(filter.relation)))throw new PublicCheckInputError('filter requires a numeric comparison relation');
  rows=rows.filter(row=>comparePublicValues(row.value,filter.value,filter.relation));
 }
 if(args.order!==undefined){
  if(!['ascending','descending'].includes(String(args.order)))throw new PublicCheckInputError('Invalid order');
  rows.sort((a,b)=>args.order==='ascending'?a.value-b.value:b.value-a.value);
 }
 if(args.rank!==undefined){
  if(!args.order||!Number.isSafeInteger(args.rank)||Number(args.rank)<1)throw new PublicCheckInputError('rank must be a positive 1-based position with an explicit order');
  const index=Number(args.rank)-1,ranked=rows[index];
  if(!ranked)throw new PublicCheckInputError('Requested rank exceeds the selected row count; the declared evidence does not establish that rank');
  // No arbitrary tie-breaking: a boundary tie must be resolved by the workflow.
  if(ranked&&(rows[index-1]?.value===ranked.value||rows[index+1]?.value===ranked.value))throw new PublicCheckInputError('Rank is ambiguous because values are tied at that position');
  rows=[ranked];
 }
 if(args.selection!==undefined&&(!Array.isArray(args.selection)||args.selection.some(id=>typeof id!=='string')||args.selection.length>256))throw new PublicCheckInputError('selection must be an array of at most 256 string IDs');
 const selectedIds=rows.map(row=>row.id),checked=args.selection!==undefined;
 return {checked,passed:checked?comparePublicValues(selectedIds,args.selection,'set_equal'):null,result:{selectedIds,rows},scope};
}

/** RFC 6901 own-property traversal; missing values never compare equal to null. */
export function publicPointer(value:JsonValue|unknown,path:unknown):unknown{
 if(typeof path!=='string'||(path!==''&&!path.startsWith('/'))||/~(?![01])/u.test(path))throw new PublicCheckInputError('path must be a JSON Pointer, e.g. /result/total');
 let current=value;
 for(const token of path===''?[]:path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'))){
  if(Array.isArray(current)&&! /^(0|[1-9]\d*)$/.test(token))throw new PublicCheckInputError('Array JSON Pointer components must be canonical nonnegative indices');
  if(current===null||typeof current!=='object'||!Object.hasOwn(current,token))throw new PublicCheckInputError(`No observed own property at ${path}`);
  current=(current as Record<string,unknown>)[token];
 }
 return current;
}

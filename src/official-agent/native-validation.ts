import type {AgentDefinition,AgentNode} from '@codesoul-co/ditto/runtime';
import {DefinitionError} from '../graph-agent/schema.js';
import {NATIVE_CONTRACTS,HOST_INFER_MESSAGES_SCHEMA,PROGRESS_HISTORY_SCHEMA,LAYERED_HISTORY_SCHEMA,DECISION_ATTEMPT_SCHEMA,AUTOMATION_REVIEW_SCHEMA,AUTOMATION_REVIEW_FEEDBACK_SCHEMA} from './native-contracts.js';
import {STANDARD_TOOL_CONTRACTS} from './tool-contracts.js';

type Shape=Record<string,any>;
const pointer=(key:string)=>key.replace(/~/g,'~0').replace(/\//g,'~1');
const dynamic=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)&&['$ref','$op','$map'].some(key=>Object.hasOwn(value,key));
const fail=(message:string,path:string,hint:string):never=>{throw new DefinitionError(message,path,hint);};
const kind=(value:any)=>value===null?'null':Array.isArray(value)?'array':typeof value;

/** Check only declared, statically known values. Expressions retain runtime validation. */
export function validateNativeLiteral(value:any,schema:Shape,path:string):void {
 if(!schema||dynamic(value))return;
 if(value&&typeof value==='object'&&Object.hasOwn(value,'$literal'))value=value.$literal;
 const alternatives=schema.anyOf??schema.oneOf;
 if(alternatives){
  const errors:unknown[]=[];
  for(const alternative of alternatives){try{validateNativeLiteral(value,alternative,path);return;}catch(error){errors.push(error);}}
  throw errors.filter((error):error is DefinitionError=>error instanceof DefinitionError).sort((a,b)=>b.path.length-a.path.length)[0]??new DefinitionError('Value does not match a native input alternative',path);
 }
 if(schema.const!==undefined&&JSON.stringify(value)!==JSON.stringify(schema.const))fail('Native value must equal '+JSON.stringify(schema.const),path,'Use the documented literal value.');
 if(schema.enum&&!schema.enum.some((v:any)=>JSON.stringify(v)===JSON.stringify(value)))fail('Native value must be one of '+JSON.stringify(schema.enum),path,'Use an exact native enum value; a natural-language purpose is not an enum.');
 const types=Array.isArray(schema.type)?schema.type:schema.type?[schema.type]:[];
 if(types.length&&!types.some((type:string)=>type===kind(value)||type==='integer'&&typeof value==='number'&&Number.isInteger(value)))fail(`Native input requires ${types.join(' or ')}, received ${kind(value)}`,path,'Use the native input schema; do not substitute a string for a strategy object.');
 if(typeof value==='string'){
  if(schema.minLength!==undefined&&value.length<schema.minLength)fail('Native string is too short',path,'Supply a nonempty native field.');
  if(schema.maxLength!==undefined&&value.length>schema.maxLength)fail('Native string exceeds its declared limit',path,'Respect the native field length limit.');
 }
 if(typeof value==='number'){
  if(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)fail('Native numeric field is outside its declared bounds',path,'Use the native numeric limits.');
 }
 if(Array.isArray(value)){
  if(schema.minItems!==undefined&&value.length<schema.minItems)fail('Native array has too few items',path,'Supply the required native elements.');
  if(schema.items)value.forEach((entry,index)=>validateNativeLiteral(entry,schema.items,`${path}/${index}`));
 }else if(value&&typeof value==='object'){
  for(const field of schema.required??[])if(!Object.hasOwn(value,field))fail(`Required native input field ${field} is missing`,`${path}/${pointer(field)}`,'Add the field using the exact input schema and a declared expression or literal.');
  for(const [key,entry]of Object.entries(value)){
   const property=schema.properties?.[key];
   if(property)validateNativeLiteral(entry,property,`${path}/${pointer(key)}`);
   else if(schema.additionalProperties===false)fail(`Unknown native input field ${key}`,`${path}/${pointer(key)}`,'Use the documented native field names.');
   else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validateNativeLiteral(entry,schema.additionalProperties,`${path}/${pointer(key)}`);
  }
 }
}

function helperOutput(node:AgentNode):Shape|undefined {
 if(node.type!=='HOST.DATA.TRANSFORM')return undefined;
 const operation=(node.input as any)?.operation;
 if(operation==='text'&&((node.input as any)?.preserveNull===true||dynamic((node.input as any)?.preserveNull)))return{anyOf:[{type:'string'},{type:'null'}]};
 if(['json','text','concat','evidence'].includes(operation))return{type:'string'};
 if(operation==='memory-ids')return{type:'array',items:{type:'string'}};
 if(operation==='decision')return{type:'object',properties:{done:{type:'boolean'},tool:{type:'string'},arguments:{type:'object'},finalAnswer:{type:'string'}},additionalProperties:false};
 if(operation==='decision-attempt')return DECISION_ATTEMPT_SCHEMA;
 if(operation==='automation-review')return AUTOMATION_REVIEW_SCHEMA;
 if(operation==='automation-review-feedback')return AUTOMATION_REVIEW_FEEDBACK_SCHEMA;
 if(operation==='tool-history-progress')return PROGRESS_HISTORY_SCHEMA;
 if(operation==='tool-history-layered')return LAYERED_HISTORY_SCHEMA;
 if(['bfcl-history','tool-history'].includes(operation))return{type:'object',properties:{complete:{type:'boolean'},history:{type:'array',items:{type:'object'}}},additionalProperties:false};
 return{}; // parse/coalesce and user JSON contents have deliberately unknown shapes.
}

/** undefined means provably invalid; {} means the producer's dynamic JSON remains open. */
function pathShape(schema:Shape,parts:string[]):Shape|undefined {
 if(!parts.length)return schema;
 if(schema.anyOf||schema.oneOf){
  const matches=(schema.anyOf??schema.oneOf).map((branch:Shape)=>pathShape(branch,parts)).filter((v:Shape|undefined)=>v!==undefined);
  return matches.length?{anyOf:matches}:undefined;
 }
 if(!schema.type&&!schema.properties)return{};
 const [head,...tail]=parts;
 if(schema.type==='array')return head==='length'&&!tail.length?{type:'integer'}:/^(0|[1-9]\d*)$/.test(head!)?pathShape(schema.items??{},tail):undefined;
 if(schema.type&&schema.type!=='object')return undefined;
 if(Object.hasOwn(schema.properties??{},head!))return pathShape(schema.properties[head!],tail);
 if(schema.additionalProperties===false)return undefined;
 return typeof schema.additionalProperties==='object'?pathShape(schema.additionalProperties,tail):{};
}

/** Pure structural preflight. Never invokes a model, tool, private judge or task world. */
export function validateOfficialNativeContracts(definition:AgentDefinition):void {
 const catalogue=NATIVE_CONTRACTS as unknown as Record<string,{inputSchema:Shape;outputSchema:Shape;outputPaths?:unknown}>;
 for(const [graphId,graph]of Object.entries(definition.graphs)){
  const producers=new Map(graph.nodes.map(node=>[node.id,node]));
  const outputFor=(producer:AgentNode):Shape|undefined=>{
   const base=helperOutput(producer)??catalogue[producer.type]?.outputSchema;
   let act=producer;
   if(producer.type==='INTERACTION.OBSERVE'){
    const ref=(producer.input as any)?.result?.$ref;
    const source=typeof ref==='string'&&/^nodes\.[^.]+$/.test(ref)?producers.get(ref.split('.')[1]!):undefined;
    if(source&&'type'in source)act=source;
   }
   if(base&&act.type==='INTERACTION.ACT.TOOL'){
    const name=(act.input as any)?.call?.name,tool=STANDARD_TOOL_CONTRACTS.find(tool=>tool.name===name);
    if(tool)return{...base,properties:{...base.properties,structuredContent:tool.successStructuredContentSchema}};
   }
   return base;
  };
  const inspect=(value:any,path:string):void=>{
   if(!value||typeof value!=='object'||Object.hasOwn(value,'$literal'))return;
   if(typeof value.$ref==='string'&&value.$ref.startsWith('nodes.')){
    const [,nodeId,...parts]=value.$ref.split('.'),producer=producers.get(nodeId);
    if(producer&&'type'in producer){
     const shape=outputFor(producer);
     if(shape&&pathShape(shape,parts)===undefined&&!Object.hasOwn(value,'default'))fail(`Invalid native output path ${value.$ref} for ${producer.type}`,`${path}/$ref`,`Read the producer's outputSchema/outputPaths. ${producer.type.startsWith('CONTEXT.')||producer.type.startsWith('INTERACTION.')?'This operation returns a direct value; do not insert an output wrapper.':'Preserve the actual NodeResult wrapper where declared.'} No path is silently rewritten.`);
    }
   }
   for(const [key,entry]of Object.entries(value))inspect(entry,`${path}/${pointer(key)}`);
  };
  graph.nodes.forEach((node,index)=>{
   const path=`/graphs/${pointer(graphId)}/nodes/${index}`;
   if('type'in node){
    const schema=catalogue[node.type]?.inputSchema;
    if(schema){
     // The immutable host fills these Infer fields before calling the native handler.
     const required=node.type.startsWith('INFER.REASONING.')?(schema.required??[]).filter((v:string)=>!['model','generation'].includes(v)):schema.required;
     validateNativeLiteral(node.input,{...schema,...(required?{required}:{})},`${path}/input`);
     if(node.type.startsWith('INFER.REASONING.'))validateNativeLiteral((node.input as any)?.messages,HOST_INFER_MESSAGES_SCHEMA,`${path}/input/messages`);
    }
    if(node.type==='INTERACTION.ACT.TOOL'){
     const call=(node.input as any)?.call,tool=STANDARD_TOOL_CONTRACTS.find(tool=>tool.name===call?.name);
     if(tool&&call&&Object.hasOwn(call,'arguments'))validateNativeLiteral(call.arguments,tool.inputSchema as Shape,`${path}/input/call/arguments`);
    }
   }
   inspect(node.input,`${path}/input`);
  });
  inspect(graph.output,`/graphs/${pointer(graphId)}/output`);
 }
}

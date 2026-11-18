export interface PublicDataflowDiagnostic {readonly code:string;readonly message:string;readonly sourceNodeId:string;}

/** Distinguish successful tool transport from a failed executable public check. */
export function publicToolDiagnostics(graphId:string,nodeId:string,input:any,output:any):readonly PublicDataflowDiagnostic[]{
 const sourceNodeId=`${graphId}/${nodeId}`,name=input?.call?.name;
 if(['public_python_check','public_data_check'].includes(name)&&output?.status==='success'&&output?.structuredContent?.passed===false)
  return[{code:'PUBLIC_CHECK_FAILED',sourceNodeId,message:'The executed caller-supplied check failed. Use its actual input and returned diagnostics; transport success is not a passed check. No official reference answer or hidden assertion was consulted.'}];
 if(name==='bfcl_respond'&&output?.structuredContent?.completionCheck?.passed===false)
  return[{code:'COMPLETION_CHECK_FAILED',sourceNodeId,message:'Declared targets were not established by fresh actual observations. This turn was not submitted. Read the returned check evidence and repair or obtain a fresh readback before retrying.'}];
 if(output?.status==='failed'&&output?.error?.code==='B_TOOL_INPUT')
  return[{code:'TOOL_INPUT_PRECONDITION',sourceNodeId,message:'A real tool invocation failed its input contract. Preserve the error and check the route and arguments before retrying; a fallback answer does not establish that the tool ran successfully.'}];
 return[];
}

/** The compiler has already applied assign. Expose a scalar Graph result being
 * read as an object through defaults, without changing assignments or answers. */
export function loopResultDiagnostics(graphId:string,step:string,assign:unknown,result:unknown):readonly PublicDataflowDiagnostic[]{
 const diagnostics:PublicDataflowDiagnostic[]=[];
 const visit=(value:unknown,path:string):void=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((item,index)=>visit(item,`${path}/${index}`));return;}
  const object=value as Record<string,unknown>;
  if(Object.hasOwn(object,'$literal'))return;
  if(typeof object.$ref==='string'&&object.$ref.startsWith('result.')
   &&(result===null||typeof result!=='object')&&Object.hasOwn(object,'default')){
   const kind=result===null?'null':typeof result;
   diagnostics.push({code:'LOOP_RESULT_SHAPE_MISMATCH',sourceNodeId:`${graphId}/@loop:${step}`,
    message:`Loop step ${step} received a Graph output of type ${kind}, but assignment ${path} reads ${object.$ref}. That property does not exist on this scalar Graph output, so the declared default was used. Read result itself or deliberately project an object from the Graph. This observation does not choose an answer or change the fallback.`});
  }
  for(const [key,child]of Object.entries(object))visit(child,`${path}/${key}`);
 };
 visit(assign,'assign');return diagnostics;
}

/** Diagnose observed values and their declared direct producer; never select an answer. */
export function nullFallbackDiagnostics(graphId:string,nodeId:string,declaration:any,inputs:Readonly<Record<string,any>>,outputs:Readonly<Record<string,any>>):readonly PublicDataflowDiagnostic[]{
 const current=inputs[`${graphId}/${nodeId}`];
 if(current?.operation!=='coalesce'||!Array.isArray(current.value)||!Array.isArray(declaration?.input?.value))return[];
 const chosen=current.value.findIndex((value:unknown)=>value!==null&&value!==undefined);
 if(chosen<0||current.value[chosen]!=='null'||!current.value.slice(chosen+1).some((value:unknown)=>value!==null&&value!==undefined))return[];
 const ref=declaration.input.value[chosen]?.$ref;
 if(typeof ref!=='string'||!/^nodes\.[^.]+$/.test(ref))return[];
 const prefix=nodeId.slice(0,nodeId.lastIndexOf('/')+1),sourceNodeId=`${graphId}/${prefix}${ref.split('.')[1]}`;
 const source=inputs[sourceNodeId];
 if(source?.operation!=='text'||source.preserveNull===true||source.value!=null||outputs[sourceNodeId]!=='null')return[];
 return[{code:'NULL_FALLBACK_SHADOWED',sourceNodeId,
  message:`A missing value from ${sourceNodeId} was serialized as the string "null", so this coalesce selects it before the later non-null fallback. Keep absence until selection: use text with preserveNull:true, or apply coalesce before text. Literal text "null", 0, false and empty strings remain valid values.`}];
}

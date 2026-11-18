import assert from 'node:assert/strict';
import test from 'node:test';
import {checkPublicData,comparePublicValues,publicPointer} from '../ditto/public-checks.js';
import {createPublicPythonCheck} from '../ditto/public-python-check.js';
import {createBfclTools} from '../ditto/bfcl-tools.js';
import {bfclScope,type BfclSession} from '../benchmark/bfcl.js';
import {HOST_TOOL_CONTRACTS} from '../official-agent/native-contracts.js';

test('public row checks expose wrong ordinal and incomplete threshold selections',()=>{
 const rows=[{id:'a',value:12},{id:'b',value:55.2},{id:'c',value:15.3},{id:'d',value:10.3},{id:'e',value:7.1}];
 const rank=checkPublicData({operation:'select',rows,order:'descending',rank:3,selection:['c']});
 assert.equal(rank.passed,false);assert.deepEqual((rank.result as any).selectedIds,['a']);
 const threshold=checkPublicData({operation:'select',rows:[{id:'a',value:21.8},{id:'b',value:13.1},{id:'c',value:31.7},{id:'d',value:20.1}],filter:{relation:'gt',value:20},selection:['c']});
 assert.equal(threshold.passed,false);assert.deepEqual((threshold.result as any).selectedIds,['a','c','d']);
 assert.equal(checkPublicData({operation:'select',rows,order:'descending',rank:3,selection:['a']}).passed,true);
 assert.equal(checkPublicData({operation:'select',rows}).passed,null);
});
test('checks preserve numeric types, empty selections and unresolved ties',()=>{
 assert.equal(comparePublicValues('40',40,'equal'),false);
 assert.equal(checkPublicData({operation:'select',rows:[{id:'a',value:1}],filter:{relation:'gt',value:2},selection:[]}).passed,true);
 assert.throws(()=>checkPublicData({operation:'select',rows:[{id:'a',value:1},{id:'b',value:1}],order:'descending',rank:1}),/tied/);
 assert.throws(()=>checkPublicData({operation:'select',rows:[{id:'a',value:1}],order:'descending',rank:2,selection:[]}),/exceeds/);
 assert.throws(()=>checkPublicData({operation:'compare',actual:'40',target:50,relation:'lt'}),/not coerced/);
 assert.throws(()=>publicPointer({field:null},'/absent'),/No observed/);
 assert.equal(publicPointer({'a/b':{'~x':0}},'/a~1b/~0x'),0);
});
test('closing the public Python capability cancels its process and forbids later execution',async()=>{
 let executions=0;
 const tool=createPublicPythonCheck({async judge(_request,signal){executions++;return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});}});
 const args={source:'def f(): return 1',entryPoint:'f',checks:'def check(): assert f() == 1'};
 const pending=tool.execute(args,{} as never),stopped=assert.rejects(pending,/closed/);
 await tool.close();await stopped;await assert.rejects(tool.execute(args,{} as never),/closed/);assert.equal(executions,1);
});
test('public Python tool executes exactly the supplied source and checks, returning real diagnostics',async()=>{
 let received:any;
 const tool=createPublicPythonCheck({async judge(request){received=request;return{passed:false,diagnostics:'ValueError: invalid literal',durationMs:1};}});
 const args={source:"def f(s):\n    return [int(c) for c in s]",entryPoint:'f',checks:"def check():\n    f('abc')"};
 const result=await tool.execute(args,{} as never);
 assert.equal(result.status,'success');assert.equal((result.structuredContent as any).passed,false);
 assert.equal(received.candidate,args.source);assert.equal(received.testSource,args.checks);assert.deepEqual(received.testImports,[]);
 assert.match(String((result.structuredContent as any).diagnostics),/ValueError/);
 assert.equal((await tool.execute({...args,entryPoint:'f); import os'},{} as never)).status,'failed');
});
test('BFCL completion checks block a real wrong state, allow repair, and cannot borrow another turn',async()=>{
 let turn=0;const submissions:any[]=[],calls:any[]=[];
 const session:BfclSession={tools:['bfcl_call','bfcl_respond'].map(name=>({name,inputSchema:HOST_TOOL_CONTRACTS[name]!.inputSchema as any})),assertHealthy(){},async call(name,args){
  calls.push({name,args});if(name==='bfcl_respond'){submissions.push(args);return{turn:++turn,history:[],complete:false};}
  return{turn,history:[],complete:false,observations:[JSON.stringify({total:args.calls&&((args.calls as any[])[0].arguments.total)})]};
 }};
 await bfclScope.run(session,async()=>{
  const tools=createBfclTools(),call=tools.find(t=>t.name==='bfcl_call')!,respond=tools.find(t=>t.name==='bfcl_respond')!;
  const acted=await call.execute({turn:0,calls:[{name:'change',arguments:{total:50}}]},{} as never);
  assert.equal(((acted.structuredContent as any).executionEvidence.calls[0]).callIndex,0);
  const check={id:'total',callIndex:0,path:'/total',relation:'equal',target:40};
  const rejected=await respond.execute({turn:0,message:'done',completionChecks:[check]},{} as never);
  assert.equal((rejected.structuredContent as any).turn,0);assert.match(String((rejected.structuredContent as any).error),/COMPLETION_CHECK_FAILED/);assert.equal(submissions.length,0);
  await call.execute({turn:0,calls:[{name:'change',arguments:{total:40}}]},{} as never);
  const outdated=await respond.execute({turn:0,message:'done',completionChecks:[{...check,target:50}]},{} as never);
  assert.match(JSON.stringify(outdated),/STALE_OBSERVATION/);assert.equal(submissions.length,0);
  const accepted=await respond.execute({turn:0,message:'done',completionChecks:[{...check,callIndex:1}]},{} as never);
  assert.equal((accepted.structuredContent as any).turn,1);assert.equal(submissions.length,1);assert(!Object.hasOwn(submissions[0],'completionChecks'));
  const stale=await respond.execute({turn:1,message:'done',completionChecks:[{...check,callIndex:1}]},{} as never);
  assert.equal((stale.structuredContent as any).turn,1);assert.equal(submissions.length,1);
  await respond.execute({turn:1,message:'legacy submission'},{} as never);assert.equal(submissions.length,2);
  assert.equal(calls.filter(call=>call.name==='bfcl_call').length,2);
 });
});

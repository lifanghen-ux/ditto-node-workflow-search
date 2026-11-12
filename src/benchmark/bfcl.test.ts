import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {bfclScope,OfficialBfclSession,validateBfclSnapshot,bfclScoringCheckpoint,verifyBfclRecords} from './bfcl.js';
import {createBfclTools} from '../ditto/bfcl-tools.js';
import {extractPythonCandidate,dockerCommand} from './docker-python-judge.js';

test('BFCL interface observations remain in their conversation and transport failures remain engineering faults',async()=>{
 const requests:unknown[]=[];
 const session=new OfficialBfclSession('multi_turn_base_1',async value=>{requests.push(value);return{turn:0,error:'Stale turn; use the actual current turn'};},async()=>{});
 const observation=await session.call('bfcl_call',{turn:3,calls:[]});assert.match(String(observation.error),/Stale turn/);session.assertHealthy();assert.equal(requests.length,1);
 const tools=await bfclScope.run(session,async()=>{const registered=createBfclTools();assert.equal(registered.length,3);const result=await registered[0]!.execute({},{} as never);assert.equal(result.status,'success');assert.match(JSON.stringify(result.structuredContent),/Stale turn/);return registered;});
 await assert.rejects(tools[0]!.execute({},{} as never),/outside its registered conversation/);
 const second=new OfficialBfclSession('multi_turn_base_2',async()=>({turn:1}),async()=>{});
 await bfclScope.run(second,()=>assert.rejects(tools[0]!.execute({},{} as never),/outside its registered conversation/));
 const broken=new OfficialBfclSession('multi_turn_base_3',async()=>{throw Error('environment disconnected');},async()=>{});
 await assert.rejects(broken.call('bfcl_state',{}),/disconnected/);assert.throws(()=>broken.assertHealthy(),/disconnected/);
 await session.close();assert.throws(()=>session.assertHealthy(),/closed/);assert.equal(createBfclTools().length,0);
});

test('BFCL scoring recovery is bound to the original task, repeat, answer and official snapshot',()=>{
 const snapshot={contract:'bfcl-shared-conversation-v1',world:{id:'multi_turn_base_1',result:[[]],unavailable:[],forced:false}};
 validateBfclSnapshot(snapshot,'multi_turn_base_1');
 const execution={taskId:'bfcl:multi_turn_base_1',caseId:'bfcl:multi_turn_base_1#1',answer:'Finished',snapshot,trace:[],sessionId:'scope1'};
 assert.equal(bfclScoringCheckpoint(execution,execution.taskId,execution.caseId,execution.answer),execution);
 assert.throws(()=>bfclScoringCheckpoint(execution,execution.taskId,'bfcl:multi_turn_base_1#2',execution.answer),/repeat/);
 assert.throws(()=>bfclScoringCheckpoint(execution,execution.taskId,execution.caseId,'Different answer'),/prediction/);
 assert.throws(()=>bfclScoringCheckpoint({...execution,snapshot:{...snapshot,world:{...snapshot.world,id:'multi_turn_base_2'}}},execution.taskId,execution.caseId,execution.answer),/checkpoint/);
 assert.throws(()=>validateBfclSnapshot({contract:'other',world:snapshot.world},'multi_turn_base_1'),/checkpoint/);
});

test('BFCL public observation shapes distinguish lists, objects and void without evaluating returned code',()=>{
 const python=process.env.DITTO_PROVIDER_PYTHON??'python';
 const bridge=fileURLToPath(new URL('../../scripts/official_bfcl_bridge.py',import.meta.url));
 const source=`import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('bridge',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nvalues=["[{'id': 1, 'status': 'Open'}]",'{"id":1}', 'None', '__import__("module_that_must_not_run").exit()']\nprint(json.dumps([module.observation_shape(value,{'type':'dict'}) for value in values]))`;
 const rows=JSON.parse(execFileSync(python,['-I','-B','-c',source,bridge],{encoding:'utf8',windowsHide:true}));
 assert.equal(rows[0].format,'python-literal');assert.equal(rows[0].observed.kind,'array');assert.equal(rows[0].observed.length,1);assert.equal(rows[0].schemaShapeMismatch,true);
 assert.equal(rows[1].observed.kind,'object');assert.equal(rows[1].schemaShapeMismatch,false);
 assert.equal(rows[2].observed.kind,'null');assert.equal(rows[3].format,'raw-text');
 assert(!JSON.stringify(rows).includes('ground_truth'));
});

test('BFCL publication verification rejects a correct-size fabricated dataset before any environment starts',async()=>{
 const bytes=Buffer.from(Array.from({length:200},(_,id)=>JSON.stringify({id:`bfcl:fake_${id}`,prompt:'synthetic fixture'})).join('\n'));
 await assert.rejects(verifyBfclRecords(bytes,'validate'),/publication verification failed/);
});

test('MFlow verifier uses Python canonical numbers and preserves ordered-record identity',async()=>{
 const python=process.env.DITTO_PROVIDER_PYTHON??'python';
 const script=new URL('../../scripts/verify_mflow_records.py',import.meta.url);
 // The verifier's digest is over the exact immutable bytes passed on stdin, not a second file read.
 const expected=execFileSync(python,['-c',"import hashlib,json;print(hashlib.sha256(json.dumps([{'id':'a','value':1.0}],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())"],{encoding:'utf8',windowsHide:true}).trim();
 const result=execFileSync(python,['-B',fileURLToPath(script), '1',expected],{input:'{"value":1.0,"id":"a"}\n',encoding:'utf8',windowsHide:true});assert.equal(JSON.parse(result).recordsSha256,expected);
});

test('MBPP extraction never imports its prose/signature scaffold and WSL selection stays a host setting',()=>{
 const output='```python\ndef answer(xs):\n    return len(xs)\n```';
 const candidate=extractPythonCandidate(output,'Write a function.\nimport misleading_example\ndef answer(xs):\n    pass','answer','mbpp');
 assert.match(candidate,/return len/);assert.doesNotMatch(candidate,/misleading_example|Write a function/);
 const old=process.env.CODE_JUDGE_WSL_DISTRO;
 try{process.env.CODE_JUDGE_WSL_DISTRO='Ubuntu';assert.deepEqual(dockerCommand(['version']),{file:'wsl.exe',args:['--distribution','Ubuntu','--user','root','--exec','docker','version']});delete process.env.CODE_JUDGE_WSL_DISTRO;assert.equal(dockerCommand(['version']).file,'docker');}
 finally{if(old===undefined)delete process.env.CODE_JUDGE_WSL_DISTRO;else process.env.CODE_JUDGE_WSL_DISTRO=old;}
});

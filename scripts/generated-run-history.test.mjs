import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compactRunHistory,readRunHistory} from './generated-run-history.mjs';

test('history snapshots keep evidence pointers without serializing full runtime traces',()=>{
  const traces={toJSON(){throw Error('Full traces must stay in JSONL');}};
  const origin={directory:'original-run',candidateId:'original-id'};
  const history=[{id:'generated-001',proposal:{source:'same'},traces},
    {id:'previous-seed-a',traceEvidence:origin,traces}];
  const compact=compactRunHistory(history,'current-run');
  assert.doesNotThrow(()=>JSON.stringify(compact));
  assert.deepEqual(compact[0].traceEvidence,{directory:resolve('current-run'),candidateId:'generated-001'});
  assert.equal(compact[1].traceEvidence,origin);
  assert.equal(history[0].traces,traces);
  assert.ok(!Object.hasOwn(compact[0],'traces'));
});

test('oversized legacy history is recovered without parsing or overwriting its trace dump',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-compact-history-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'candidates'));await mkdir(join(root,'evaluations','seed-a'),{recursive:true});
  const legacy='not parsed: '+'legacy trace dump '.repeat(100);
  await writeFile(join(root,'history.json'),legacy);
  await writeFile(join(root,'candidates','seed-a.json'),JSON.stringify({proposal:{source:'unchanged model code'}}));
  await writeFile(join(root,'evaluations','seed-a','summary.json'),JSON.stringify({examples:1,repeats:1,valid:true,score:1}));
  await writeFile(join(root,'evaluations','seed-a','samples.jsonl'),JSON.stringify({caseId:'a#1',valid:true,score:1}));
  await writeFile(join(root,'evaluations','seed-a','live-samples.jsonl'),[
    {caseId:'a#1',valid:true,score:1},{caseId:'b#1',valid:false,error:'HTTP 402',score:0},
  ].map(row=>JSON.stringify(row)).join('\n'));
  const history=await readRunHistory(root,{maxEmbeddedHistoryBytes:1});
  assert.equal(history[0].proposal.source,'unchanged model code');
  assert.equal(history[0].evaluation.results.length,2);
  assert.equal(history[0].evaluation.valid,false);
  assert.deepEqual(history[0].engineeringFeedback,['HTTP 402']);
  assert.equal(await readFile(join(root,'history.json'),'utf8'),legacy);
});

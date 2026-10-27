import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {graph,graphStep,loop} from '@codesoul-co/ditto/runtime';
import {compileGeneratedWorkflowA} from './generated-workflow-a.mjs';
import {compileEvidenceDefinition} from './generated-workflow-b.mjs';
import {sharedTools,unwrap,parseJson,answerText} from './workflow-capabilities.mjs';

test('repository prompt inputs prepare both executable seeds without a cache, paid calls or source mutation',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'ditto-prompt-'));
  try {
    const destination=join(temporary,'inputs');
    const result=spawnSync(process.execPath,['scripts/prepare-user-prompt-run.mjs',destination],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const bundle=JSON.parse(await readFile(join(destination,'prompt-bundle.json'),'utf8'));
    assert.match(bundle.optimizer,/自主设计者/);
    assert.match(bundle.guideA,/TRAJECTORY/);assert.match(bundle.guideB,/REFLECT/);
    const capabilities={graph,graphStep,loop,model:{provider:'fixture',model:'fixed'},generation:{temperature:0,maxTokens:393216},unwrap,parseJson,answerText,allowedTools:sharedTools.map(t=>t.name)};
    for(const representation of ['A','B']) {
      const seed=JSON.parse(await readFile(join(destination,'seed-'+representation+'.json'),'utf8'));
      const original=JSON.parse(await readFile('examples/generated-seeds/'+representation+'.json','utf8'));
      assert.equal(seed.proposal.referenceCandidateId,null);
      assert.equal(seed.origin.historicalScoresReused,false);
      if(representation==='A') {
        assert.match(seed.proposal.source,/你只能依据提供的文章/);
        const prefix=original.proposal.source.split('const system = [')[0];
        const suffix=original.proposal.source.split("].join(' ');").slice(1).join("].join(' ');");
        assert.ok(seed.proposal.source.startsWith(prefix));assert.ok(seed.proposal.source.endsWith(suffix));
        compileGeneratedWorkflowA(seed.proposal.source,capabilities);
      } else {
        const strip=value=>{value=structuredClone(value);for(const n of value.nodes)for(const m of n.inputBindings.messages??[])if(m.role==='system')m.content='';return value;};
        assert.deepEqual(strip(seed.proposal.definition),strip(original.proposal.definition));
        assert.match(seed.proposal.definition.nodes[0].inputBindings.messages[0].content,/提取证据/);
        compileEvidenceDefinition(seed.proposal.definition,capabilities);
      }
    }
    const frozen=await readFile(join(destination,'prompt-bundle.json'),'utf8');
    const repeated=spawnSync(process.execPath,['scripts/prepare-user-prompt-run.mjs',destination],{encoding:'utf8'});
    assert.notEqual(repeated.status,0);
    assert.equal(await readFile(join(destination,'prompt-bundle.json'),'utf8'),frozen);
  } finally {await rm(temporary,{recursive:true,force:true});}
});

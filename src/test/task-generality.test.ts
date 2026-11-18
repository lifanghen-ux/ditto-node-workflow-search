import assert from 'node:assert/strict';
import test from 'node:test';
import {assertReusableStrategy} from '../official-agent/task-generality.js';
import {OFFICIAL_BASELINE} from '../official-agent/schema.js';
import type {BenchmarkTask} from '../domain.js';

test('task-specific function conventions are blocked while prompt bindings and generic terms remain valid',()=>{
 const tasks:BenchmarkTask[]=[{id:'coding:1',dataset:'mbpp',prompt:'Public specification.',outputInstruction:'',metadata:{entryPoint:'convert_case'}},
  {id:'coding:2',dataset:'mbpp',prompt:'Another specification.',outputInstruction:'',metadata:{entryPoint:'count'}}];
 const definition={...structuredClone(OFFICIAL_BASELINE),config:{strategy:'Read the actual signature from the prompt. Count elements; check conventions against public evidence.'}};
 assert.doesNotThrow(()=>assertReusableStrategy(definition,tasks));
 const specialized={...definition,config:{strategy:'If the function is convert_case, always use upper case.'}};
 assert.throws(()=>assertReusableStrategy(specialized,tasks),/convert_case/);
 assert.doesNotThrow(()=>assertReusableStrategy(specialized,[{...tasks[0]!,dataset:'bfcl',metadata:{entryPoint:'convert_case'}}]));
});

import test from "node:test";
import assert from "node:assert/strict";
import { graph } from "@codesoul-co/ditto/runtime";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { GENERATION } from "../protocol.js";

const settings = { baseUrl:"https://offline.invalid", model:"fixture", apiKey:"offline", concurrency:1, timeoutMs:1000 };

test("provider admission gates each native TRAJECTORY round before a model call", async () => {
  let admitted=0, invoked=0;
  const runtime=createExperimentRuntime(settings, {
    beforeProviderCall(){ if (++admitted>1) throw Error("SEARCH_BUDGET_EXHAUSTED"); },
    provider:{async invoke(){invoked++;return {message:{role:"assistant",content:"fixture"},finishReason:"stop"};}},
  });
  try {
    const plan=graph("budget-test").node("trajectory","INFER.REASONING.TRAJECTORY",[],()=>({
      model:{provider:"deepseek",model:"fixture"},generation:GENERATION,
      messages:[{role:"user",content:"test"}],strategy:{name:"cot",options:{rounds:3}},constraints:{maxSteps:Number.MAX_SAFE_INTEGER},
    }));
    const result=await runtime.runtime.run(plan,{});
    assert.equal(invoked,1);
    assert.ok(admitted>=2);
    assert.match(JSON.stringify(result),/SEARCH_BUDGET_EXHAUSTED/);
  } finally {await runtime.close();}
});

test("reflection format retries pass the same provider admission boundary", async () => {
  let admitted=0, invoked=0;
  const runtime=createExperimentRuntime(settings, {
    beforeProviderCall(){ if (++admitted>1) throw Error("SEARCH_BUDGET_EXHAUSTED"); },
    provider:{async invoke(){invoked++;return {message:{role:"assistant",content:JSON.stringify({assessment:{summary:"ok",passed:true},issues:[{severity:"info",description:"checked",suggestedFix:null}]})},finishReason:"stop"};}},
  });
  try {
    const plan=graph("reflection-budget").node("reflect","INFER.REASONING.REFLECT",[],()=>({
      model:{provider:"deepseek",model:"fixture"},generation:GENERATION,
      mode:"verify",target:{result:{role:"assistant",content:"fixture"}},metadata:{nodeType:"INFER.REASONING.REFLECT"},
    }));
    const result=await runtime.runtime.run(plan,{});
    assert.equal(invoked,1);
    assert.equal(admitted,2);
    assert.match(JSON.stringify(result),/SEARCH_BUDGET_EXHAUSTED/);
  } finally {await runtime.close();}
});

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SampleInput, SampleOutput } from '@codesoul-co/ditto/worker/infer';

export interface ModelOutputRecord { readonly nodeId: unknown; readonly finishReason: SampleOutput['finishReason']; }
const scope=new AsyncLocalStorage<ModelOutputRecord[]>();
export function captureModelOutputs<T>(run:(records:ModelOutputRecord[])=>Promise<T>):Promise<T>{
  const records:ModelOutputRecord[]=[];return scope.run(records,()=>run(records));
}
/** The bridge has already confirmed transport completion. Keep the real reason in evidence. */
export function acceptReceivedOutput(input:SampleInput, output:SampleOutput):SampleOutput {
  scope.getStore()?.push({nodeId:input.metadata?.nodeId,finishReason:output.finishReason});
  if(output.finishReason!=='length' || !['INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE'].includes(String(input.metadata?.nodeType)))return output;
  // Core 0.1.1 requires "stop" before parsing these nodes. Let its real schema
  // validate the received JSON; no continuation, generation or repair is added.
  return {...output,finishReason:'stop',message:{...output.message,metadata:{...output.message.metadata,receivedFinishReason:'length'}}};
}
export class OutputBudgetAnswerError extends Error {}

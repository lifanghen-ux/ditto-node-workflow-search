import type { ModelProvider, SampleInput } from '@codesoul-co/ditto/worker/infer';
// Pinned MFlow provider-progress.ts repetition policy; no additional rule.
/** Only identical completed action/result cycles count; useful new work has no quota. */
export function repeatedToolCycles(messages: SampleInput['messages'], computationsOnly = false): number {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  const calls = new Map<string, [string, unknown]>(), completed: string[] = [];
  for (const message of messages.slice(-64)) {
    const metadata = message.metadata as { actionRequests?: { id: string; name: string; arguments: unknown }[]; actionRequestId?: string } | undefined;
    for (const call of metadata?.actionRequests ?? []) calls.set(call.id, [call.name, stable(call.arguments)]);
    if (message.role === 'tool' && metadata?.actionRequestId && calls.has(metadata.actionRequestId)) {
      const call = calls.get(metadata.actionRequestId)!;
      // Fresh Python sandboxes can produce different random counterexamples or
      // traceback details from the same unchanged faulty program. Requiring the
      // observation to match allowed these loops to run indefinitely. Stateful
      // API reads/writes are excluded from this computation-only check.
      completed.push(JSON.stringify(computationsOnly
        ? ['python', 'arithmetic'].includes(call[0]) ? call : ['non-computation', completed.length]
        : [call, message.content]));
    }
  }
  let best = 0;
  for (let period = 1; period <= 4; period++) {
    let count = 1;
    while (completed.length >= (count + 1) * period && completed.slice(-period).every((s, i) => s === completed[completed.length - (count + 1) * period + i])) count++;
    best = Math.max(best, count);
  }
  return best;
}


export function withBaselineRepetitionGuidance(provider: ModelProvider): ModelProvider {
 return {async invoke(input, options) {
 const repeats=Math.max(repeatedToolCycles(input.messages),repeatedToolCycles(input.messages,true));
 if(repeats>=5)throw Object.assign(new Error('Unchanged tool computation or action/result cycle continued after recovery guidance; use existing evidence instead of repeating it'),{code:'DEGENERATE_OUTPUT'});
 if(repeats>=4)input={...input,messages:[...input.messages,{role:'user',content:"Execution diagnostic: the same tool operation and arguments have repeated four times. Randomized tests can return different counterexamples without changing the faulty program. Inspect the existing results, correct the implementation or assumptions, or finish with the supported answer. Do not rerun the unchanged computation; changing the actual method or test arguments is allowed."}]};
 return provider.invoke(input,options);
 }};
}

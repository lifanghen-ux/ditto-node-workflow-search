export default function createWorkflow(api) {
  const g = api.graph('mbpp-solve')
    .node(
      'plan',
      'INFER.REASONING.SAMPLE',
      [],
      (input) => ({
        messages: [
          {
            role: 'system',
            content:
              'You are a careful Python engineer. Read the specification and produce a short analysis, not code. ' +
              'Identify: (1) the exact required behavior, (2) the function signature and return type, ' +
              '(3) concrete edge cases the hidden tests likely cover (empty input, zero, negatives, duplicates, ordering, types), ' +
              '(4) any ambiguity and the most standard interpretation. Be concise and concrete.'
          },
          {
            role: 'user',
            content:
              'Specification:\n' + input.prompt +
              (input.outputInstruction ? '\n\nOutput instruction:\n' + input.outputInstruction : '')
          }
        ]
      })
    )
    .node(
      'solve',
      'INFER.REASONING.SAMPLE',
      ['plan'],
      (input, { plan }) => {
        const analysis = api.unwrap(plan).message.content;
        return {
          messages: [
            {
              role: 'system',
              content:
                'You write correct Python for hidden unit tests. Output exactly one fenced ```python code block containing the complete solution ' +
                'with any needed imports. Preserve the given entry point and signature exactly. No tests, no commentary, no extra text outside the block. ' +
                'Handle the edge cases listed in the analysis. Prefer simple, standard-library-only code.'
            },
            {
              role: 'user',
              content:
                'Specification:\n' + input.prompt +
                (input.outputInstruction ? '\n\nOutput instruction:\n' + input.outputInstruction : '') +
                '\n\nPrior analysis (edge cases and interpretation):\n' + analysis +
                '\n\nNow write the final solution as a single ```python code block.'
            }
          ]
        };
      }
    );

  const loop = api.loop({
    id: 'mbpp-solve-loop',
    maxIterations: Number.MAX_SAFE_INTEGER,
    *plan(task) {
      const outputs = yield* api.graphStep(g, {
        prompt: task.prompt,
        outputInstruction: task.outputInstruction || ''
      });
      const raw = api.unwrap(outputs.solve).message.content;
      const text = typeof raw === 'string' ? raw : String(raw);
      const fence = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
      const code = fence ? fence[1].trim() : text.trim();
      return { answer: code };
    }
  });

  return {
    id: 'mbpp-solve',
    definition: loop,
    outputNodeId: 'solve'
  };
}
export default function createWorkflow(api) {
  const g = api.graph('humaneval-solve')
    .node('draft', 'INFER.REASONING.SAMPLE', [], (input, localOutputs) => ({
      messages: [
        {
          role: 'system',
          content: [
            'You are an expert Python programmer solving a HumanEval-style task.',
            'You will be given a function signature and docstring. Produce a complete, correct implementation.',
            '',
            'Requirements:',
            '- Preserve the exact function name and signature from the prompt.',
            '- Include any imports the implementation needs (place them at the top of the code block).',
            '- Handle edge cases implied by the docstring and doctests: empty inputs, zero, one, negatives, case sensitivity, duplicates, and boundary values.',
            '- Do not add tests, example usage, or commentary outside the code block.',
            '',
            'Output format (strict):',
            '1. A short CONTRACT section with these labeled lines:',
            '   SIGNATURE: <exact def line>',
            '   IMPORTS: <comma-separated modules or NONE>',
            '   RULES: <2-5 bullet rules the code must satisfy, including any tie-break, ordering, case, or boundary rule stated in the docstring>',
            '2. Then exactly one fenced Python code block containing the full solution.',
            'The code block must be the last thing in your response.',
            'Before writing the code, re-read your RULES and make sure the code literally implements each one (e.g. if a rule says ties keep original index order, the sort key must include the index).'
          ].join('\n')
        },
        {
          role: 'user',
          content: input.prompt + (input.outputInstruction ? '\n\n' + input.outputInstruction : '')
        }
      ],
      metadata: { nodeType: 'draft' }
    }))
    .node('revise', 'INFER.REASONING.REFLECT', ['draft'], (input, localOutputs) => {
      const draft = api.unwrap(localOutputs.draft);
      const draftText = typeof draft.message.content === 'string'
        ? draft.message.content
        : JSON.stringify(draft.message.content);
      return {
        messages: [
          {
            role: 'user',
            content: [
              'Original task:',
              input.prompt,
              input.outputInstruction ? '\n' + input.outputInstruction : '',
              '',
              'Draft solution (contains a CONTRACT section and a code block):',
              draftText,
              '',
              'Check the code against every RULE in the CONTRACT and against the docstring examples.',
              'Pay special attention to: tie-break / stable-ordering rules, case-insensitivity, negative numbers, empty inputs, and boundary indices.',
              'If any rule is not literally implemented by the code, return a corrected full implementation in revisedResult.',
              'If the code already satisfies every rule, return the code unchanged in revisedResult.',
              'revisedResult must be a single fenced Python code block with the full solution and no commentary.'
            ].join('\n')
          }
        ],
        target: { result: draft.message },
        mode: 'revise',
        criteria: [
          { id: 'signature', description: 'Function name and signature exactly match the prompt.', weight: 1 },
          { id: 'imports', description: 'All required imports are present inside the code block.', weight: 1 },
          { id: 'rules', description: 'Every RULE in the CONTRACT (tie-break, ordering, case, boundary) is literally implemented by the code.', weight: 3 },
          { id: 'edge-cases', description: 'Handles edge cases implied by the docstring and doctests (empty, zero, one, negatives, case, duplicates).', weight: 2 },
          { id: 'correctness', description: 'The implementation is logically correct for all doctest examples and reasonable hidden tests.', weight: 3 },
          { id: 'format', description: 'Output is exactly one fenced Python code block with no tests or commentary.', weight: 1 }
        ],
        metadata: { nodeType: 'revise' }
      };
    });

  const loop = api.loop({
    id: 'humaneval-loop',
    maxIterations: Number.MAX_SAFE_INTEGER,
    *plan(task) {
      const outputs = yield* api.graphStep(g, {
        prompt: task.prompt,
        outputInstruction: task.outputInstruction || ''
      });

      let answer = '';
      try {
        const revised = api.unwrap(outputs.revise);
        if (revised && revised.revisedResult && typeof revised.revisedResult.content === 'string') {
          answer = revised.revisedResult.content;
        }
      } catch (e) {
        answer = '';
      }

      if (!answer) {
        try {
          const draft = api.unwrap(outputs.draft);
          answer = typeof draft.message.content === 'string'
            ? draft.message.content
            : JSON.stringify(draft.message.content);
        } catch (e) {
          answer = '';
        }
      }

      return { answer: api.answerText(answer) };
    }
  });

  return {
    definition: loop,
    outputNodeId: 'revise',
    id: 'humaneval-solve-revise'
  };
}
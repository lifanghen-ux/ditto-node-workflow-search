export default function createWorkflow(api) {
  const g = api.graph('drop-main')
    .node('load', 'CONTEXT.LOAD', [], (input) => ({
      sources: [{ role: 'user', content: String(input.prompt || '') }]
    }))
    .node('solve', 'INFER.REASONING.SAMPLE', ['load'], (input, local) => {
      const passage = api.unwrap(local.load).items.map((it) => it.content).join('\n');
      const instruction = input.outputInstruction ? String(input.outputInstruction) : 'Return a concise final answer.';
      const system = [
        'You answer questions using ONLY the supplied passage.',
        'Do not use outside knowledge; if the passage does not state it, do not add it.',
        'You may do arithmetic grounded in the passage; a derived answer need not appear verbatim.',
        'If several entities are requested, include the complete requested set in one answer.',
        'Preserve necessary signs, decimal values and entity names.',
        'Decide the answer TYPE from the question wording:',
        '- If the question asks for a distance, count, percentage, age, year, or other measurement (e.g. "what distance", "how many", "how much", "what percent"), answer with the BARE value only (e.g. "3" or "3 yards"), NOT a descriptive phrase naming the player or event.',
        '- If the question asks "who", "which entity", "which group", or names a person/team/place, answer with the exact name as written in the passage.',
        '- If the question asks for a ranking (most/least/second/third), first list the candidate values with their labels, sort them, then answer with the label of the requested rank.',
        '- If the question asks a comparison ("was more X or Y", "which was greater"), answer with the NAME of the larger item, not a number.',
        'For numeric questions, give the bare requested value (no units unless the question asks for them, no equation, no repeated unit).',
        'Return exactly one answer; never give alternative guesses.',
        'When arithmetic is needed, first identify the exact passage numbers that answer the question (watch for similar values attached to different entities), then build the expression from those numbers only.',
        'Respond as strict JSON with keys: answer (string, the concise final answer, no newlines), expression (string, a pure arithmetic expression using only + - * / ( ) and the selected passage numbers that computes the answer, or empty string if no arithmetic is needed or the answer is a name/comparison), and basis (string, a short note naming which passage values you selected and why, or empty string).'
      ].join(' ');
      const user = 'Passage:\n' + passage + '\n\nQuestion:\n' + String(input.prompt || '') + '\n\nOutput instruction:\n' + instruction;
      return {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        model: api.model,
        generation: api.generation
      };
    })
    .node('arith', 'INTERACTION.ACT.TOOL', ['solve'], (input, local) => {
      const raw = api.unwrap(local.solve).message.content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      let expr = '';
      try {
        const parsed = api.parseJson(text);
        if (parsed && typeof parsed.expression === 'string') expr = parsed.expression.trim();
      } catch (e) {
        expr = '';
      }
      const pureArith = /^[0-9+\-*/().\s]+$/.test(expr) && /[0-9]/.test(expr);
      return {
        call: {
          id: 'arith-1',
          name: 'arithmetic',
          arguments: { expression: pureArith ? expr : '0' }
        }
      };
    });

  function normalizeAnswer(answer, expr, toolValue) {
    let a = String(answer == null ? '' : answer).replace(/\s+/g, ' ').trim();
    const pureArith = expr && /^[0-9+\-*/().\s]+$/.test(expr) && /[0-9]/.test(expr);
    if (pureArith && toolValue !== null && Number.isFinite(toolValue)) {
      const numMatch = a.match(/-?\d+(?:\.\d+)?/);
      if (numMatch) {
        const stated = Number(numMatch[0]);
        const denom = Math.max(Math.abs(stated), Math.abs(toolValue), 1e-9);
        const relDiff = Math.abs(stated - toolValue) / denom;
        if (relDiff > 0.02) a = String(toolValue);
      }
    }
    const numericOnly = /^-?\d+(?:\.\d+)?\s*(?:percentage points?|percent|per cent|%)?$/i.test(a);
    if (numericOnly) {
      const m = a.match(/-?\d+(?:\.\d+)?/);
      if (m) {
        const n = Number(m[0]);
        if (Number.isFinite(n)) a = String(n);
        else a = m[0];
      }
    }
    return a;
  }

  const loop = api.loop({
    id: 'drop-loop',
    maxIterations: Number.MAX_SAFE_INTEGER,
    *plan(task) {
      const outputs = yield* api.graphStep(g, {
        prompt: task.prompt,
        outputInstruction: task.outputInstruction
      });
      const raw = api.unwrap(outputs.solve).message.content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      let answer = '';
      let expr = '';
      try {
        const parsed = api.parseJson(text);
        if (parsed && typeof parsed.answer === 'string') answer = parsed.answer;
        if (parsed && typeof parsed.expression === 'string') expr = parsed.expression.trim();
      } catch (e) {
        answer = text;
      }
      let toolValue = null;
      try {
        const tool = api.unwrap(outputs.arith);
        if (tool && tool.structuredContent && typeof tool.structuredContent.value === 'number') {
          toolValue = tool.structuredContent.value;
        }
      } catch (e) {
        toolValue = null;
      }
      const finalAnswer = normalizeAnswer(answer, expr, toolValue);
      return { answer: api.answerText(finalAnswer) };
    }
  });

  return {
    definition: loop,
    outputNodeId: 'arith',
    id: 'drop-workflow'
  };
}

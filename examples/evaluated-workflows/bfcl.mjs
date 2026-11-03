export default function createWorkflow(api) {
  // ---- Graph: fetch state only ----
  let gState = api.graph('bfcl-state-graph');
  gState = gState.node('state-call', 'INTERACTION.ACT.TOOL', [], () => ({
    call: { id: 'bfcl-state', name: 'bfcl_state', arguments: {} },
  }));
  gState = gState.node('state-observe', 'INTERACTION.OBSERVE', ['state-call'], (input, localOutputs) => ({
    result: localOutputs['state-call'],
  }));

  // ---- Graph: decide next action (single SAMPLE) ----
  let gDecide = api.graph('bfcl-decide-graph');
  gDecide = gDecide.node('decide', 'INFER.REASONING.SAMPLE', [], (input) => {
    const prompt = input && input.prompt ? String(input.prompt) : '';
    const stateText = input && input.stateText ? String(input.stateText) : '';
    const logText = input && input.logText ? String(input.logText) : '';
    const retryNote = input && input.retryNote ? String(input.retryNote) : '';
    const system = [
      'You are an agent completing an official BFCL multi-turn conversation.',
      'You see only the current turn and the revealed history. Use the official tools via the control JSON below.',
      'Available official functions are listed in CURRENT STATE under "functions"; never invent names or arguments.',
      'Return STRICT JSON only, no markdown, exactly one of:',
      '{"goal":"<one short sentence: what the CURRENT user turn asks for>","referent":"<if the turn refers to earlier content (e.g. \'my last question\', \'that file\', \'the first two files\'), quote the exact earlier text/name it points to; else empty>","action":"call","calls":[{"name":"...","arguments":{...},"required_info_present":true}]}',
      '{"goal":"...","referent":"...","action":"clarify","message":"<question asking only for the missing value>"}',
      '{"goal":"...","referent":"...","action":"respond","message":"..."}',
      'Rules:',
      '- Resolve referents from the revealed history. If the user says to write/use \'my last question\' or similar, the referent is the earlier user text, NOT the current instruction.',
      '- Before any irreversible action (send, post, create, write, delete, purchase), check every value the user goal needs is present in the current turn or history. If a needed value is missing, choose clarify instead of a partial commit.',
      '- Do not repeat calls already executed successfully for this turn (see EXECUTED). If a prior call failed, read the real error and adjust arguments or preconditions; a legitimate retry after fixing a precondition is allowed.',
      '- When the current turn is fully handled AND all required state changes were actually executed via calls, choose respond with a concise message reflecting actual results. Never describe an action as done unless a call performed it.',
      '- Only act on the current turn; do not anticipate future turns.',
    ].join('\n');
    let user = [
      'TASK:',
      prompt,
      '',
      'CURRENT STATE (turn, complete, functions, history):',
      stateText || '(none)',
      '',
      'EXECUTED THIS TURN (calls + real results):',
      logText || '(none)',
    ].join('\n');
    if (retryNote) {
      user = user + '\n\nYOUR PREVIOUS OUTPUT WAS NOT VALID JSON. Raw output:\n' + retryNote + '\nReturn only the strict JSON object now.';
    }
    return {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
  });

  // ---- Graph: execute business function calls ----
  let gCall = api.graph('bfcl-call-graph');
  gCall = gCall.node('call-tool', 'INTERACTION.ACT.TOOL', [], (input) => {
    const calls = Array.isArray(input && input.calls) ? input.calls : [];
    const turn = input && typeof input.turn === 'number' ? input.turn : 0;
    return {
      call: { id: 'bfcl-call', name: 'bfcl_call', arguments: { turn, calls } },
    };
  });
  gCall = gCall.node('call-observe', 'INTERACTION.OBSERVE', ['call-tool'], (input, localOutputs) => ({
    result: localOutputs['call-tool'],
  }));

  // ---- Graph: submit turn response ----
  let gRespond = api.graph('bfcl-respond-graph');
  gRespond = gRespond.node('respond-tool', 'INTERACTION.ACT.TOOL', [], (input) => {
    const turn = input && typeof input.turn === 'number' ? input.turn : 0;
    const message = input && typeof input.message === 'string' ? input.message : '';
    return {
      call: { id: 'bfcl-respond', name: 'bfcl_respond', arguments: { turn, message } },
    };
  });
  gRespond = gRespond.node('respond-observe', 'INTERACTION.OBSERVE', ['respond-tool'], (input, localOutputs) => ({
    result: localOutputs['respond-tool'],
  }));

  function extractStructured(envelope) {
    try {
      const u = api.unwrap(envelope);
      if (u && u.structuredContent && typeof u.structuredContent === 'object') return u.structuredContent;
      if (u && u.message) {
        const c = u.message.content;
        if (typeof c === 'string') {
          try { return api.parseJson(c); } catch (e) { return null; }
        }
        if (Array.isArray(c)) {
          for (const part of c) {
            if (part && part.type === 'json' && part.data && typeof part.data === 'object') return part.data;
          }
          const txt = c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
          try { return api.parseJson(txt); } catch (e) { return null; }
        }
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // Compact the state so functions/history are sent once, not duplicated.
  function compactState(stateJson) {
    if (!stateJson || typeof stateJson !== 'object') return '';
    const out = {};
    if (typeof stateJson.turn === 'number') out.turn = stateJson.turn;
    if (stateJson.complete === true) out.complete = true;
    if (stateJson.functions) out.functions = stateJson.functions;
    if (stateJson.history) out.history = stateJson.history;
    if (stateJson.current_turn !== undefined) out.current_turn = stateJson.current_turn;
    if (stateJson.message !== undefined) out.message = stateJson.message;
    return JSON.stringify(out);
  }

  const loop = api.loop({
    id: 'bfcl-loop',
    maxIterations: Number.MAX_SAFE_INTEGER,
    *plan(task) {
      const prompt = String(task && task.prompt ? task.prompt : '');
      let stateText = '';
      let logText = '';
      let complete = false;
      let lastMessage = '';
      let turn = 0;
      let guard = 0;
      let needState = true;

      while (!complete && guard < 80) {
        guard += 1;

        // 1) Fetch fresh state only when we don't already have it from a prior tool result.
        if (needState) {
          const stateOut = yield* api.graphStep(gState, {});
          const stateJson = extractStructured(stateOut['state-observe']);
          if (stateJson && typeof stateJson === 'object') {
            stateText = compactState(stateJson);
            if (typeof stateJson.turn === 'number') turn = stateJson.turn;
            if (stateJson.complete === true) { complete = true; break; }
          }
          needState = false;
        }

        // 2) Decide next action; retry once on unparseable output instead of faking Done.
        let decision = null;
        let retryNote = '';
        for (let attempt = 0; attempt < 2 && !decision; attempt += 1) {
          const decideOut = yield* api.graphStep(gDecide, { prompt, stateText, logText, retryNote });
          let raw = '';
          try {
            const unwrapped = api.unwrap(decideOut['decide']);
            const content = unwrapped && unwrapped.message ? unwrapped.message.content : '';
            raw = typeof content === 'string' ? content : JSON.stringify(content);
            decision = api.parseJson(raw);
          } catch (e) {
            decision = null;
          }
          if (!decision || typeof decision !== 'object' || !decision.action) {
            decision = null;
            retryNote = raw ? raw.slice(0, 1200) : '(empty)';
          }
        }
        if (!decision) {
          // Cannot fabricate completion; submit an honest status and let the turn advance.
          const fallback = lastMessage || 'I could not complete this step reliably.';
          const respondResult = yield* api.graphStep(gRespond, { message: fallback, turn });
          const respondJson = extractStructured(respondResult['respond-observe']);
          if (respondJson && typeof respondJson === 'object') {
            if (respondJson.complete === true) complete = true;
            if (typeof respondJson.turn === 'number') turn = respondJson.turn;
            stateText = compactState(respondJson);
          }
          logText = '';
          needState = false;
          continue;
        }

        if (decision.action === 'call' && Array.isArray(decision.calls) && decision.calls.length > 0) {
          const calls = decision.calls.map((c) => ({
            name: String(c.name),
            arguments: c.arguments && typeof c.arguments === 'object' ? c.arguments : {},
          }));
          const callResult = yield* api.graphStep(gCall, { calls, turn });
          const callJson = extractStructured(callResult['call-observe']);
          const callText = callJson ? JSON.stringify(callJson) : '';
          logText = (logText ? logText + '\n' : '') + 'CALLS: ' + JSON.stringify(calls) + '\nRESULT: ' + callText;
          // bfcl_call returns updated turn/history; refresh stateText from it to avoid a redundant state fetch.
          if (callJson && typeof callJson === 'object') {
            if (typeof callJson.turn === 'number') turn = callJson.turn;
            if (callJson.complete === true) { complete = true; break; }
            if (callJson.history) stateText = compactState(callJson);
          }
          needState = false;
          continue;
        }

        // 3) Submit the turn response (respond or clarify both submit a message).
        const message = typeof decision.message === 'string' && decision.message.trim()
          ? decision.message
          : (lastMessage || 'Done.');
        lastMessage = message;
        const respondResult = yield* api.graphStep(gRespond, { message, turn });
        const respondJson = extractStructured(respondResult['respond-observe']);
        if (respondJson && typeof respondJson === 'object') {
          if (respondJson.complete === true) complete = true;
          if (typeof respondJson.turn === 'number') turn = respondJson.turn;
          stateText = compactState(respondJson);
        }
        logText = '';
        needState = false;
      }

      return { answer: lastMessage || 'Done.' };
    },
  });

  return { definition: loop, outputNodeId: 'decide', id: 'bfcl-multiturn-workflow' };
}

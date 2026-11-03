export default function createWorkflow(api) {
  const MAX_TURNS = 32;
  const KEEP_RECENT = 6;

  const SYSTEM = [
    'You are a workflow automation agent operating simulated business APIs.',
    'You must accomplish the user task by calling tools. Final text alone does not change the world.',
    'Tools:',
    '  api_search(query, top_k) -> discover endpoints (returns full endpoint details incl. URL and parameter schema).',
    '  api_fetch(method, url, params, body) -> execute an endpoint. params/body are JSON strings or null.',
    '  base64_encode(text) -> base64url encode (for Gmail raw/body fields).',
    '',
    'Respond with a single JSON object and nothing else. No markdown, no prose.',
    'Decision schema:',
    '  {"action":"search","query":"...","top_k":5}',
    '  {"action":"fetch","method":"GET|POST|PUT|PATCH|DELETE","url":"...","params":{...}|null,"body":{...}|null}',
    '  {"action":"encode","text":"..."}',
    '  {"action":"done","summary":"..."}',
    '',
    'Rules:',
    '- Discover endpoints with api_search before calling api_fetch; use the exact URL and parameter names returned.',
    '- Never invent resource identifiers; use values from tool observations.',
    '- Do not ask clarifying questions; make reasonable assumptions.',
    '- Before appending a row to a spreadsheet or creating a record in a table, read the sheet/table schema or existing rows so column order and field names match the real structure. Do not assume the order of values in the user text equals the column order.',
    '- After a write that the task depends on (create/update/send/append), read the affected resource back and confirm the stored values match the task. If they do not, correct them.',
    '- If a service/endpoint is reported as not connected or repeatedly errors, do not retry it; record it as unavailable and proceed with alternatives.',
    '- Do not repeat an identical request that already failed; change parameters or path.',
    '- When summarizing, list only items you acted on.',
    '- Emit {"action":"done"} only when the environment state actually satisfies the task and you have verified the key writes.',
  ].join('\n');

  function buildDecideGraph() {
    let g = api.graph('decide-graph');
    g = g.node('decide', 'INFER.REASONING.SAMPLE', [], (input) => ({
      messages: input.messages,
    }));
    return g;
  }

  function buildToolGraph() {
    let g = api.graph('tool-graph');
    g = g.node('call', 'INTERACTION.ACT.TOOL', [], (input) => ({
      call: { id: input.callId, name: input.name, arguments: input.arguments },
    }));
    return g;
  }

  const decideGraph = buildDecideGraph();
  const toolGraph = buildToolGraph();

  function parseDecision(text) {
    try {
      const obj = api.parseJson(text);
      if (obj && typeof obj === 'object' && typeof obj.action === 'string') return obj;
      return null;
    } catch (e) {
      return null;
    }
  }

  function obsText(res) {
    if (res.structuredContent !== undefined) return JSON.stringify(res.structuredContent);
    if (res.content !== undefined) return typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    if (res.error !== undefined) return JSON.stringify(res.error);
    return JSON.stringify(res);
  }

  function clip(s, n) {
    if (typeof s !== 'string') s = String(s);
    return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
  }

  return {
    id: 'automationbench-verify-first-agent',
    outputNodeId: 'decide',
    definition: api.loop({
      id: 'main',
      maxIterations: Number.MAX_SAFE_INTEGER,
      *plan(task) {
        const head = [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: task.prompt + (task.outputInstruction ? '\n\n' + task.outputInstruction : '') },
        ];
        const recent = [];
        const earlier = [];
        const unavailable = [];
        const attempted = new Set();
        const writes = [];
        let finalAnswer = '';
        let callSeq = 0;

        function buildMessages() {
          const msgs = head.slice();
          if (earlier.length) {
            msgs.push({ role: 'user', content: 'EARLIER STEPS (compressed):\n' + earlier.join('\n') });
          }
          for (const m of recent) msgs.push(m);
          if (unavailable.length) {
            msgs.push({ role: 'user', content: 'Known unavailable services (do not retry): ' + unavailable.join('; ') });
          }
          if (writes.length) {
            msgs.push({ role: 'user', content: 'Writes performed so far: ' + writes.join('; ') });
          }
          return msgs;
        }

        function pushMsg(m) {
          recent.push(m);
          while (recent.length > KEEP_RECENT) {
            const old = recent.shift();
            const c = typeof old.content === 'string' ? old.content : JSON.stringify(old.content);
            earlier.push(old.role + ': ' + clip(c, 400));
          }
        }

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const outputs = yield* api.graphStep(decideGraph, { messages: buildMessages() });
          const env = api.unwrap(outputs.decide);
          const msg = env.message;
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          pushMsg({ role: 'assistant', content });

          const decision = parseDecision(content);
          if (!decision) {
            pushMsg({
              role: 'user',
              content: 'Your previous reply was not valid JSON matching the decision schema. Reply with exactly one JSON decision object.',
            });
            continue;
          }

          const action = decision.action;
          if (action === 'done') {
            finalAnswer = typeof decision.summary === 'string' && decision.summary.trim()
              ? decision.summary
              : 'Completed the requested workflow using the available tools.';
            break;
          }

          let name = null;
          let args = null;
          let sig = null;
          if (action === 'search') {
            name = 'api_search';
            args = { query: String(decision.query || ''), top_k: Number(decision.top_k) || 5 };
            sig = 'search|' + args.query + '|' + args.top_k;
          } else if (action === 'fetch') {
            name = 'api_fetch';
            args = {
              method: String(decision.method || 'GET').toUpperCase(),
              url: String(decision.url || ''),
              params: decision.params == null ? null : (typeof decision.params === 'string' ? decision.params : JSON.stringify(decision.params)),
              body: decision.body == null ? null : (typeof decision.body === 'string' ? decision.body : JSON.stringify(decision.body)),
            };
            sig = 'fetch|' + args.method + '|' + args.url + '|' + (args.params || '') + '|' + (args.body || '');
          } else if (action === 'encode') {
            name = 'base64_encode';
            args = { text: String(decision.text || '') };
            sig = 'encode|' + args.text;
          } else {
            pushMsg({ role: 'user', content: 'Unknown action "' + action + '". Use search, fetch, encode, or done.' });
            continue;
          }

          if (sig && attempted.has(sig)) {
            pushMsg({
              role: 'user',
              content: 'DUPLICATE BLOCKED: this exact request was already attempted. Do not repeat it; change parameters, choose another endpoint, or verify current state with a read.',
            });
            continue;
          }
          if (sig) attempted.add(sig);

          callSeq += 1;
          const callId = 'c' + callSeq;
          let obs;
          try {
            const toolOut = yield* api.graphStep(toolGraph, { callId, name, arguments: args });
            const res = api.unwrap(toolOut.call);
            obs = obsText(res);
            const low = obs.toLowerCase();
            if (low.includes('not connected') || low.includes('not_connected') || low.includes('unavailable')) {
              unavailable.push(name + ':' + (args.url || args.query || ''));
            }
            if (name === 'api_fetch' && args.method !== 'GET') {
              writes.push(args.method + ' ' + args.url);
            }
          } catch (e) {
            obs = 'TOOL_ERROR: ' + (e && e.message ? e.message : String(e));
          }
          pushMsg({ role: 'user', content: 'TOOL OBSERVATION (' + name + '): ' + clip(obs, 3000) });
        }

        if (!finalAnswer) {
          finalAnswer = 'Completed the requested workflow using the available tools.';
        }
        return { answer: api.answerText(finalAnswer) };
      },
    }),
  };
}

// Environment adapters only. Solving Graphs/Loops are supplied by the optimizer.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { evaluateTasks } from '../dist/benchmark/index.js';

export class JsonWorldBridge {
  constructor(python, args, env = {}) {
    this.queue = Promise.resolve(); this.failure = null; this.pending = null;
    this.child = spawn(python, ['-u', ...args], { windowsHide: true, stdio: ['pipe','pipe','pipe'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key))),
        PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8', ...env } });
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-1600); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', code => this.fail(Error('Official bridge exited ' + code + ': ' + this.stderr)));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      const pending = this.pending;
      if (!pending) return this.fail(Error('Unexpected official bridge response'));
      this.pending = null;
      try {
        const message = JSON.parse(line);
        if (!message.ok) pending.reject(Error('Official environment: ' + message.error));
        else pending.resolve(message.result);
      } catch (error) { pending.reject(error); }
    });
  }
  fail(error) { this.failure ??= error; this.pending?.reject(error); this.pending = null; }
  request(value) {
    const next = this.queue.then(() => new Promise((resolveReply, reject) => {
      if (this.failure) return reject(this.failure);
      const timer = setTimeout(() => { this.fail(Error('Official environment response timed out')); this.child.kill(); }, 120000);
      this.pending = { resolve: value => { clearTimeout(timer); resolveReply(value); },
        reject: error => { clearTimeout(timer); reject(error); } };
      this.child.stdin.write(JSON.stringify(value) + '\n');
    }));
    this.queue = next.catch(() => undefined);
    return next;
  }
  async close() { await this.queue; this.child.stdin.end(); this.lines.close(); this.child.kill(); }
}

const BFCL_GUIDE = `Use only these official BFCL interface tools through INTERACTION.ACT.TOOL:
bfcl_state({}): returns current turn, revealed conversation history, currently available function schemas, and complete.
bfcl_call({turn:integer,calls:[{name:string,arguments:object},...]}): invokes currently available official functions and returns observations. Read schemas, do not invent names. A result is in structuredContent.
bfcl_respond({turn:integer,message:string}): submits this turn's assistant response and reveals the next turn, or complete:true. Future turns, initial private state, and grader are unavailable. Final answer text alone does not submit turns. Stop acting when complete is true.
Only the optimizer decides the solving Graph, prompts, state and Loop.`;

export async function createGeneratedBenchmark({ dataset, split = 'validate', output }) {
  if (!['bfcl','automationbench'].includes(dataset)) throw Error('Unknown official environment');
  const protocol = dataset === 'bfcl' ? 'bfcl-multiturn-family-v1' : 'automationbench-public-simple-v1';
  const role = split === 'test' ? 'test' : 'search';
  const source = resolve('data',dataset,role + '.jsonl');
  const raw = await readFile(source, 'utf8');
  const rows = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const splitIds = JSON.parse(await readFile(resolve('work/mflow-current/benchmark-splits',dataset,protocol,role + '.ids.json'),'utf8'));
  const expectedIds = Array.isArray(splitIds) ? splitIds : splitIds.ids ?? splitIds.taskIds;
  const actualIds = rows.map(row => row.id);
  if (!Array.isArray(expectedIds) || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    || rows.length !== (role === 'search' ? 200 : 600)) throw Error('Official fixed task membership/order differs');
  const tasks = rows.map(row => ({ id: row.id, dataset, prompt: row.prompt,
    outputInstruction: dataset === 'bfcl' ? 'Complete the current multi-turn task using the official BFCL tools.'
      : 'Complete the workflow using the official simulated tools. Final text alone does not change the world.',
    metadata: { split, protocol } }));
  const sourceRoot = dataset === 'bfcl' ? resolve('work/gorilla/berkeley-function-call-leaderboard') : resolve('work/AutomationBench');
  const expectedRevision = dataset === 'bfcl' ? '6ea57973c7a6097fd7c5915698c54c17c5b1b6c8' : '4a8e1061254004d9dac807054eed33fad7d1ff14';
  const revision = execFileSync('git',['-C',sourceRoot,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  if (revision !== expectedRevision) throw Error('Official source revision differs');
  const context = new AsyncLocalStorage(), worlds = new Map();
  const evidenceDir = join(output,'official-worlds');
  await mkdir(evidenceDir,{recursive:true});
  const reference = new Map(rows.map(row => [row.id, dataset === 'bfcl' ? row.reference.bfclTaskId : row.reference.automationTaskId]));
  const automationBridge = dataset === 'automationbench' ? new JsonWorldBridge(
    resolve(sourceRoot,'.venv/Scripts/python.exe'), [resolve('scripts/official-automation-bridge.py')],
    { PYTHONPATH:sourceRoot }) : null;

  async function start(taskId) {
    if (dataset === 'bfcl') {
      const bridge = new JsonWorldBridge(resolve('work/bfcl-venv/Scripts/python.exe'),
        [resolve('scripts/official-bfcl-bridge.py'),'--official',sourceRoot,'--task',reference.get(taskId)]);
      await bridge.request({op:'state'});
      return { bridge, taskId, trace:[], request: value => bridge.request(value), close: () => bridge.close() };
    }
    const id = randomUUID();
    const started = await automationBridge.request({op:'start',session:id,taskId:reference.get(taskId)});
    return { taskId, id, trace:[], tools:started.tools, request: value => automationBridge.request({...value,session:id}),
      close: () => automationBridge.request({op:'close',session:id}) };
  }
  const probe = await start(tasks[0].id);
  const descriptors = dataset === 'bfcl'
    ? ['bfcl_state','bfcl_call','bfcl_respond'].map(name => ({name,description:BFCL_GUIDE}))
    : probe.tools.map(({function:tool}) => tool);
  await probe.close();
  const toolReference = dataset === 'bfcl' ? BFCL_GUIDE : descriptors.map(tool => `${tool.name}: ${tool.description}\nArguments: ${JSON.stringify(tool.parameters)}`).join('\n\n')
    + '\nCall through INTERACTION.ACT.TOOL; outputs are in structuredContent. api_search finds API descriptions, api_fetch executes business actions. api_fetch params/body must be JSON strings; use base64_encode for base64 data. The official final world is scored.';
  const tools = descriptors.map(descriptor => ({ name:descriptor.name, description:descriptor.description,
    inputSchema:descriptor.parameters ?? {type:'object'}, effects:['write'],
    validate(args) { if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Tool arguments must be an object'); },
    async execute(args) {
      const world = context.getStore();
      if (!world) throw Error('Official tool used outside its task world');
      const normalized = {...args};
      if (dataset === 'automationbench' && descriptor.name === 'api_fetch') for (const key of ['params','body']) {
        if (normalized[key] && typeof normalized[key] === 'object') normalized[key] = JSON.stringify(normalized[key]);
        else if (normalized[key] == null) delete normalized[key];
      }
      const value = await world.request({op:'call',name:descriptor.name,arguments:normalized});
      let observation = value;
      if (dataset === 'automationbench') {
        try { observation = JSON.parse(value.content); } catch { observation = {text:String(value.content)}; }
      }
      world.trace.push({name:descriptor.name,arguments:normalized,observation});
      return observation.error ? {status:'failed',structuredContent:observation,
        error:{code:'OFFICIAL_TOOL_ERROR',message:JSON.stringify(observation.error),retryable:false}}
        : {status:'success',structuredContent:observation};
    } }));
  const scorer = { expectedLabel:()=>'official task completed',
    async score(taskId,prediction) {
      const world = worlds.get(taskId);
      if (!world) throw Error('Missing executed official task world');
      try {
        const snapshot = await world.request({op:'snapshot'});
        const grade = await world.request({op:'grade',...snapshot});
        await writeFile(join(evidenceDir,taskId.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json'),JSON.stringify({taskId,protocol,revision,snapshot,grade,trace:world.trace},null,2));
        return {score:grade.score,expected:'official task completed',prediction,
          normalizedExpected:'pass',normalizedPrediction:grade.score?'pass':'fail',
          method:protocol+'-official-checker',details:{partialCredit:grade.partialCredit,errorType:grade.errorType}};
      } finally { worlds.delete(taskId); await world.close(); }
    } };
  const evaluate = (selected,runner,options) => evaluateTasks(selected,scorer,runner,{...options,retryAttempts:1});
  return { tools, toolReference, capabilityGuide:toolReference,
    sourceFiles: [resolve(dataset === 'bfcl' ? 'scripts/official-bfcl-bridge.py' : 'scripts/official-automation-bridge.py')],
    summarizeTraces:traces=>traces.map(trace=>({taskId:trace.taskId,eventCount:trace.events?.length??0})),
    prepareProviderInput(input) { return context.getStore()
      ? {...input,messages:[{role:'system',content:toolReference},...input.messages]} : input; },
    beforeProviderCall() {},
    async withTask(taskId,run) {
      const world=await start(taskId); worlds.set(taskId,world);
      try { return await context.run(world,run); }
      catch(error) {
        try { const snapshot=await world.request({op:'snapshot'});
          await writeFile(join(evidenceDir,taskId.replace(/[^a-zA-Z0-9_-]/g,'_')+'-interrupted.json'),JSON.stringify({taskId,snapshot,trace:world.trace,error:error.message},null,2)); } catch {}
        worlds.delete(taskId); await world.close(); throw error;
      }
    },
    async close() { for (const world of worlds.values()) await world.close(); worlds.clear(); await automationBridge?.close(); },
    benchmark:{dataset,split,tasks,identity:{protocol,upstreamCommit:revision,splitRole:role,selectedCount:tasks.length,
      sourceFile:source,rawSha256:createHash('sha256').update(raw).digest('hex'),verified:true},
      evaluate:(runner,options)=>evaluate(tasks,runner,options),
      evaluateSearchSubset(ids,runner,options) {
        if (split!=='validate' || !ids.length || new Set(ids).size!==ids.length) throw Error('Invalid official Search subset');
        return evaluate(ids.map(id=>{const task=tasks.find(task=>task.id===id);if(!task)throw Error('Unknown task');return task;}),runner,options);
      }} };
}

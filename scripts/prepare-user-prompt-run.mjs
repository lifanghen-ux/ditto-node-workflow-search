import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import assert from 'node:assert/strict';
const docs = resolve(process.argv[3] ?? 'prompts');
if (!process.argv[2])
  throw Error('Usage: node scripts/prepare-user-prompt-run.mjs <new-output-directory> [prompt-directory]');
const out = resolve(process.argv[2]);
await mkdir(dirname(out), { recursive: true });
await mkdir(out); // Never overwrite an existing run's frozen prompt inputs.
const optimizer = await readFile(join(docs, 'expanded-search-prompts.zh-CN.md'), 'utf8');
const solver = await readFile(join(docs, 'candidate-prompts-200.zh-CN.md'), 'utf8');
function section(text, start, end) {
  const i = text.indexOf(start);
  assert(i >= 0, start);
  const rest = text.slice(i + start.length);
  const j = end ? rest.indexOf(end) : rest.length;
  assert(j >= 0, end);
  return rest.slice(0, j).trim();
}
const blocks = Object.fromEntries(
  [1, 2, 3, 4, 5, 6].map((n) => [
    n,
    section(
      optimizer,
      optimizer.match(new RegExp('^## ' + n + '\\. .+$', 'm'))[0],
      n < 6 ? '\n## ' + (n + 1) + '. ' : null,
    ),
  ]),
);
const bundle = {
  optimizer: blocks[1],
  taskContract: blocks[2],
  capabilityGuide: blocks[3],
  guideA: blocks[4] + '\n\n' + blocks[6],
  guideB: blocks[5] + '\n\n' + blocks[6],
};
await writeFile(join(out, 'prompt-bundle.json'), JSON.stringify(bundle, null, 2));
await writeFile(join(out, 'expanded-search-prompts.zh-CN.md'), optimizer);
await writeFile(join(out, 'candidate-prompts-200.zh-CN.md'), solver);
const prompts = {
  solve: section(solver, '### solve：解题节点', '[查看完整候选代码]'),
  'extract-evidence': section(solver, '### extract-evidence：提取证据节点', '### draft-answer：最终答案节点'),
  'draft-answer': section(solver, '### draft-answer：最终答案节点', '[查看完整候选定义]'),
};
for (const rep of ['A', 'B']) {
  const origin = resolve('examples/generated-seeds/' + rep + '.json');
  const saved = JSON.parse(await readFile(origin, 'utf8'));
  const proposal = structuredClone(saved.proposal);
  proposal.referenceCandidateId = null;
  proposal.rationale = '用户提供的中文答题提示词替换原模型候选中的对应系统提示词；本次从零重新评分。';
  if (rep === 'A') {
    const start = proposal.source.indexOf('const system = [');
    const end = proposal.source.indexOf("].join(' ');", start) + "].join(' ');".length;
    assert(start >= 0 && end > start);
    const before = proposal.source;
    proposal.source =
      before.slice(0, start) + 'const system = ' + JSON.stringify(prompts.solve) + ';' + before.slice(end);
    assert(proposal.source.startsWith(before.slice(0, start)) && proposal.source.endsWith(before.slice(end)));
  } else {
    let replacements = 0;
    for (const node of proposal.definition.nodes)
      for (const message of node.inputBindings.messages ?? []) {
        if (message.role === 'system') {
          assert(prompts[node.id]);
          message.content = prompts[node.id];
          replacements++;
        }
      }
    assert.equal(replacements, 2);
    const strip = (x) => {
      x = structuredClone(x);
      for (const n of x.nodes) for (const m of n.inputBindings.messages ?? []) if (m.role === 'system') m.content = '';
      return x;
    };
    assert.deepEqual(strip(proposal.definition), strip(saved.proposal.definition));
  }
  await writeFile(
    join(out, 'seed-' + rep + '.json'),
    JSON.stringify(
      {
        representation: rep,
        proposal,
        origin: { artifact: origin, kind: 'user-prompt-replacement', historicalScoresReused: false },
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    directory: out,
    promptLengths: Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, v.length])),
    bundleSections: Object.keys(bundle),
  }),
);

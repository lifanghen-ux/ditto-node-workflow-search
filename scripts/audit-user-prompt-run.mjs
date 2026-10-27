import { readFile, readdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
if (process.argv.length !== 5)
  throw Error('Usage: node scripts/audit-user-prompt-run.mjs <inputs-directory> <A-run-directory> <B-run-directory>');
const inputDir = resolve(process.argv[2]);
const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const bundle = await read(join(inputDir, 'prompt-bundle.json'));
const audit = [];
for (const rep of ['A', 'B']) {
  const dir = resolve(process.argv[rep === 'A' ? 3 : 4]),
    manifest = await read(join(dir, 'manifest.json'));
  assert.equal(manifest.cachedRuns, 0);
  assert.equal(manifest.repeats, 1);
  assert.deepEqual(await read(join(dir, 'prompt-bundle.json')), bundle);
  const history = await read(join(dir, 'history.json'));
  for (const row of history) {
    const saved = await read(join(dir, 'candidates', row.id + '.json'));
    assert.deepEqual(saved.proposal, row.proposal);
    if (row.id.startsWith('generated-')) {
      const names = (await readdir(join(dir, 'proposals'))).filter(
        (n) => n.startsWith(row.id + '-') && n.endsWith('-response.json'),
      );
      let matched = false;
      for (const name of names) {
        const response = await read(join(dir, 'proposals', name));
        try {
          assert.deepEqual(
            JSON.parse(response.content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')),
            saved.proposal,
          );
          matched = true;
        } catch {}
      }
      assert(matched, 'Candidate differs from model response: ' + row.id);
    }
    if (row.evaluation?.valid) {
      const rows = (await readFile(join(dir, 'evaluations', row.id, 'samples.jsonl'), 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.equal(rows.length, row.evaluation.examples);
      assert.equal(new Set(rows.map((r) => r.caseId)).size, rows.length);
      assert(Math.abs(rows.reduce((s, r) => s + r.score, 0) / rows.length - row.evaluation.score) < 1e-10);
    }
  }
  for (const name of (await readdir(join(dir, 'proposals'))).filter((n) => n.endsWith('-request.json'))) {
    const request = await read(join(dir, 'proposals', name));
    assert.equal(request.taskContract, bundle.taskContract);
    assert.equal(request.interfaceGuide, rep === 'A' ? bundle.guideA : bundle.guideB);
    assert.equal(request.capabilityGuide, bundle.capabilityGuide);
  }
  audit.push({
    representation: rep,
    status: manifest.status,
    best: manifest.best,
    usage: manifest.newUsage,
    candidates: history.map((r) => ({
      id: r.id,
      status: r.status,
      examples: r.evaluation?.examples,
      score: r.evaluation?.score,
      error: r.engineeringFeedback,
    })),
  });
}
const aIds = (await read(join(resolve(process.argv[3]), 'selection.json'))).taskIds;
assert.deepEqual(aIds, (await read(join(resolve(process.argv[4]), 'selection.json'))).taskIds);
await writeFile(join(inputDir, 'audit.json'), JSON.stringify({ checks: 'passed', runs: audit }, null, 2));
console.log(JSON.stringify(audit, null, 2));

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const REQUIRED_SETTINGS = ['representation', 'model', 'endpoint', 'generation', 'repeats', 'dataIdentity'];
const REQUIRED_USAGE = ['providerAttempts', 'inputTokens', 'outputTokens', 'totalTokens', 'unknownUsageAttempts'];

function fail(message) { throw new Error(`Generated search resume: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function readJson(path, label, optional = false) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return { found: false, value: undefined };
    fail(`cannot read ${label}`);
  }
  try { return { found: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) }; }
  catch { fail(`invalid JSON in ${label}`); }
}

async function readLatestCases(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { found: false, priorCases: [], recordsRead: 0 };
    fail('cannot read live-samples.jsonl');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Ignore trailing newlines; reject malformed interior records.
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const latest = new Map();
  for (let index = 0; index < lines.length; index++) {
    let row;
    try { row = JSON.parse(lines[index]); }
    catch {
      const ending = index === lines.length - 1 ? ' (possibly truncated final record)' : '';
      fail(`invalid JSON in live-samples.jsonl line ${index + 1}${ending}`);
    }
    if (!object(row) || typeof row.caseId !== 'string' || !row.caseId.trim())
      fail(`invalid case record in live-samples.jsonl line ${index + 1}`);
    if (row.valid === true && (typeof row.prediction !== 'string' || !Number.isFinite(row.score)))
      fail(`invalid completed case in live-samples.jsonl line ${index + 1}`);
    // Keep the latest attempt, including failures, for retry accounting.
    latest.set(row.caseId, row);
  }
  return { found: true, priorCases: [...latest.values()], recordsRead: lines.length };
}

/** Restore local evaluation state; filter it with buildWorkflowFeedback before sending to the model. */
export async function loadGeneratedResume(runDir, candidateId, expected) {
  if (typeof runDir !== 'string' || !runDir.trim()) fail('run directory is required');
  if (typeof candidateId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(candidateId))
    fail('candidate ID must be a simple artifact ID');
  if (!object(expected) || REQUIRED_SETTINGS.some(key => !Object.hasOwn(expected, key))) fail('complete expected settings are required');
  if (!['A', 'B'].includes(expected.representation) || !Number.isSafeInteger(expected.repeats) || expected.repeats < 1)
    fail('invalid expected representation or repeats');
  const directory = resolve(runDir);
  const manifest = (await readJson(join(directory, 'manifest.json'), 'manifest.json')).value;
  if (!object(manifest) || manifest.dataset !== 'drop' || manifest.split !== 'validate')
    fail('source run must be a DROP validation search');
  const observed = {
    representation: manifest.representation, model: manifest.model, endpoint: manifest.endpoint,
    generation: manifest.generation, repeats: manifest.repeats, dataIdentity: manifest.data?.identity,
  };
  for (const key of REQUIRED_SETTINGS) {
    if (observed[key] === undefined || expected[key] === undefined || !isDeepStrictEqual(observed[key], expected[key]))
      fail(`frozen setting differs: ${key}`);
  }

  const saved = (await readJson(join(directory, 'candidates', `${candidateId}.json`), 'candidate artifact')).value;
  if (!object(saved) || saved.representation !== expected.representation || !object(saved.proposal))
    fail('candidate representation differs or proposal is missing');
  const proposal = saved.proposal;
  const artifactField = expected.representation === 'A' ? 'source' : 'definition';
  const fields = ['referenceCandidateId', 'rationale', artifactField];
  if (Object.keys(proposal).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(proposal, key))
    || !(proposal.referenceCandidateId === null || typeof proposal.referenceCandidateId === 'string')
    || typeof proposal.rationale !== 'string' || !proposal.rationale.trim()
    || (artifactField === 'source' ? typeof proposal.source !== 'string' || !proposal.source.trim() : !object(proposal.definition)))
    fail('candidate proposal has invalid public fields');

  const savedHistory = await readJson(join(directory, 'history.json'), 'history.json', true);
  const rawHistory = savedHistory.found ? savedHistory.value : [];
  if (!Array.isArray(rawHistory) || rawHistory.some(row => !object(row) || typeof row.id !== 'string'))
    fail('history.json must contain candidate records');
  const history = rawHistory.filter(row => row.id !== candidateId);
  if (proposal.referenceCandidateId !== null && !history.some(row => row.id === proposal.referenceCandidateId))
    fail('candidate reference is missing from restored history');

  const optimizerUsage = (await readJson(join(directory, 'optimizer-usage.json'), 'optimizer-usage.json')).value;
  if (!object(optimizerUsage) || REQUIRED_USAGE.some(key => !Object.hasOwn(optimizerUsage, key))
    || Object.values(optimizerUsage).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))
    fail('optimizer-usage.json must contain the original nonnegative counters');
  const cases = await readLatestCases(join(directory, 'evaluations', candidateId, 'live-samples.jsonl'));
  const reusableCases = cases.priorCases.filter(row => row.valid === true && row.error === undefined).length;
  return {
    proposal, priorCases: cases.priorCases, history, optimizerUsage,
    origin: {
      directory, candidateId, sourceStatus: manifest.status ?? null,
      historyFound: savedHistory.found, liveSamplesFound: cases.found,
      caseRecordsRead: cases.recordsRead, uniqueCases: cases.priorCases.length,
      reusableCases, retryCases: cases.priorCases.length - reusableCases,
      truncatedFinalLinePolicy: 'reject',
    },
  };
}

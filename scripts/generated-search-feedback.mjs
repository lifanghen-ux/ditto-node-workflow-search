/**
 * 把 A/B 候选的评测结果整理成反馈，供优化模型设计下一版工作流。
 * 输入：候选历史（得分、预测、节点记录）和题目；输出：每个候选的反馈对象。
 * 主入口 buildGeneratedFeedback() 依次比较新旧得分、选择案例、附上节点输入输出。
 */
const FAILURE_KINDS = ['provider', 'execution', 'timeout', 'judge'];
const OMIT = Symbol('omit');
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const delta = (a, b) => a !== null && b !== null ? a - b : null;
const text = value => typeof value === 'string' ? value : '';
const clip = (value, maximum) => ({ text: value.slice(0, maximum), truncated: value.length > maximum, originalLength: value.length });
function taskPrompt(value, maximum) {
  if (value.length <= maximum) return { text: value, truncated: false, originalLength: value.length };
  const marker = '\n[...truncated...]\n';
  const available = Math.max(0, maximum - marker.length);
  // DROP 的问题在文章末尾，截断长文章时保留末尾问题。
  const tail = Math.min(available, Math.max(Math.min(800, available), Math.floor(available * .45)));
  const head = available - tail;
  return { text: value.slice(0, head) + marker + value.slice(-tail), truncated: true, originalLength: value.length };
}
const sensitive = key => /(?:private|secret|password|credential|apikey|authorization)/i.test(key)
  || /^(?:expected|normalizedexpected|reference|referenceanswer|references|gold|goldanswer|label|labels|testsource|assertions?)$/i.test(key.replace(/[^a-z0-9]/gi, ''));

function integerOption(options, name, fallback, minimum, maximum) {
  const value = options[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function publicRows(record, tasks) {
  const latest = new Map();
  for (const row of record.evaluation?.results ?? []) {
    // 提取预测、得分和用量；参考答案不进入反馈。
    if (!object(row) || typeof row.caseId !== 'string') continue;
    const id = row.caseId.replace(/#[1-9]\d*$/, '');
    if (!tasks.has(id)) continue;
    latest.set(row.caseId, { caseId: row.caseId, taskId: id,
      valid: row.valid !== false && !own(row, 'error') && finite(row.score) && row.score >= 0 && row.score <= 1 && typeof row.prediction === 'string',
      score: finite(row.score) ? row.score : null, prediction: text(row.prediction),
      failureKind: FAILURE_KINDS.includes(row.failureKind) ? row.failureKind : null,
      inputTokens: finite(row.inputTokens) ? row.inputTokens : null,
      outputTokens: finite(row.outputTokens) ? row.outputTokens : null,
      totalTokens: finite(row.totalTokens) ? row.totalTokens : null,
      usageKnown: row.usageKnown === true,
    });
  }
  return latest;
}

function taskGroups(rows) {
  const groups = new Map();
  for (const row of rows.values()) if (row.valid) {
    if (!groups.has(row.taskId)) groups.set(row.taskId, []);
    groups.get(row.taskId).push(row);
  }
  return groups;
}

// 按相同 caseId 比较新旧候选；同一题有多次结果时，先取平均差值再统计改善、退步、持平。
function pairedFeedback(referenceId, current, reference) {
  const common = reference ? [...current.values()].filter(row => row.valid && reference.get(row.caseId)?.valid) : [];
  const taskDeltas = new Map();
  for (const row of common) {
    if (!taskDeltas.has(row.taskId)) taskDeltas.set(row.taskId, []);
    taskDeltas.get(row.taskId).push(row.score - reference.get(row.caseId).score);
  }
  const means = [...taskDeltas.values()].map(mean);
  const currentValid = [...current.values()].filter(row => row.valid).length;
  const referenceValid = reference ? [...reference.values()].filter(row => row.valid).length : 0;
  return { summary: {
    status: common.length ? 'available' : 'unavailable', referenceCandidateId: referenceId,
    scope: 'common-valid-caseIds-only', overlapRuns: common.length, overlapTasks: taskDeltas.size,
    currentValidRuns: currentValid, referenceValidRuns: referenceValid,
    currentOnlyValidRuns: currentValid - common.length, referenceOnlyValidRuns: referenceValid - common.length,
    meanScoreDelta: mean(common.map(row => row.score - reference.get(row.caseId).score)), meanTaskDelta: mean(means),
    improvedTasks: means.filter(value => value > 1e-12).length,
    regressedTasks: means.filter(value => value < -1e-12).length,
    unchangedTasks: means.filter(value => Math.abs(value) <= 1e-12).length,
    note: 'These paired deltas describe only overlapping valid caseIds, not the complete validation split or unobserved repeats.',
  }, taskDeltas: new Map([...taskDeltas].map(([id, values]) => [id, mean(values)])) };
}

// 优先选取退步最大、得分最低、改善最大和答对的题目，供模型对照分析。
function chooseCases(groups, priorGroups, paired, maximum) {
  const all = [...groups].map(([id, rows]) => ({ id, rows, prior: priorGroups.get(id) ?? [],
    score: mean(rows.map(row => row.score)), pairedDelta: paired.taskDeltas.get(id) ?? null }));
  const selected = [], seen = new Set();
  const add = (value, reason) => {
    if (value && selected.length < maximum && !seen.has(value.id)) { selected.push({ ...value, reason }); seen.add(value.id); }
  };
  const ascending = [...all].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  add([...all].filter(value => value.pairedDelta !== null && value.pairedDelta < -1e-12).sort((a, b) => a.pairedDelta - b.pairedDelta)[0], 'largest-regression');
  add(ascending.find(value => value.score < 1), 'largest-loss');
  add([...all].filter(value => value.pairedDelta !== null && value.pairedDelta > 1e-12).sort((a, b) => b.pairedDelta - a.pairedDelta)[0], 'largest-improvement');
  add(ascending.find(value => value.score === 1 && !seen.has(value.id)), 'successful-control');
  // 剩余名额补充部分答对、全错和全对的案例。
  for (const predicate of [value => value.score > 0 && value.score < 1, value => value.score === 0, value => value.score === 1])
    add(ascending.find(value => !seen.has(value.id) && predicate(value)), 'additional-quality-example');
  for (const value of ascending) add(value, 'additional-quality-example');
  return selected;
}

function outcomes(rows, settings) {
  const ordered = [...rows].sort((a, b) => a.score - b.score || a.caseId.localeCompare(b.caseId));
  return { meanScore: mean(rows.map(row => row.score)), totalOutcomes: rows.length,
    outcomesTruncated: rows.length > settings.maxOutcomes,
    outcomes: ordered.slice(0, settings.maxOutcomes).map(row => {
      const prediction = clip(row.prediction, settings.maxPredictionChars);
      return { caseId: row.caseId, score: row.score, prediction: prediction.text,
        predictionTruncated: prediction.truncated, originalPredictionLength: prediction.originalLength };
    }) };
}

/** 将节点数据转成可放入反馈的 JSON，过滤敏感字段并截断长内容。 */
function runtimeValue(value, maximum) {
  let omittedFields = 0, truncated = false;
  const seen = new WeakSet();
  const visit = (item, depth) => {
    if (typeof item === 'string') { const short = clip(item, maximum); truncated ||= short.truncated; return short.text; }
    if (item === null || typeof item === 'boolean' || finite(item)) return item;
    if (typeof item !== 'object') { omittedFields++; return OMIT; }
    if (depth > 8 || seen.has(item)) { truncated = true; return { omitted: true }; }
    seen.add(item);
    if (Array.isArray(item)) {
      truncated ||= item.length > 20;
      return item.slice(0, 20).map(child => { const clean = visit(child, depth + 1); return clean === OMIT ? null : clean; });
    }
    const result = {};
    const keys = Object.keys(item);
    for (const key of keys.slice(0, 50)) {
      if (sensitive(key)) { omittedFields++; continue; }
      const clean = visit(item[key], depth + 1);
      if (clean !== OMIT) Object.defineProperty(result, key, { value: clean, enumerable: true });
    }
    if (keys.length > 50) { omittedFields += keys.length - 50; truncated = true; }
    return result;
  };
  const clean = visit(value, 0);
  const serialized = JSON.stringify(clean === OMIT ? null : clean);
  if (serialized.length > maximum) return { preview: serialized.slice(0, maximum), truncated: true, omittedFields,
    originalSanitizedLength: serialized.length };
  return { value: clean === OMIT ? null : clean, truncated, omittedFields };
}

function errorSummary(value) {
  const message = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
  const kind = /judge|scor/i.test(message) ? 'judge' : /time.?out|deadline/i.test(message) ? 'timeout'
    : /provider|http|authentication|balance|quota|rate.?limit/i.test(message) ? 'provider'
      : /compile|syntax|schema|validat|binding|node|graph|loop|execut/i.test(message) ? 'execution' : 'unspecified';
  const status = /\b([45]\d{2})\b/.exec(message);
  return { kind, ...(status ? { httpStatus: Number(status[1]) } : {}) };
}

// 从已有执行记录中提取这道题的节点输入、输出和错误摘要；记录过多时按原顺序均匀抽样。
function traceFor(record, taskId, settings, budget) {
  const runs = (record?.traces ?? []).filter(trace => trace?.taskId === taskId && Array.isArray(trace.events));
  const events = runs.flatMap((run, runIndex) => run.events.map(event => ({ event, runIndex })));
  if (!events.length) return null;
  const maximum = Math.min(settings.maxTraceEvents, events.length);
  const indices = maximum === 1 ? [events.length - 1] : Array.from({ length: maximum }, (_, index) => Math.round(index * (events.length - 1) / (maximum - 1)));
  const selected = [];
  for (const index of indices) {
    const { event, runIndex } = events[index];
    if (!object(event)) continue;
    const entry = { runIndex };
    for (const key of ['kind', 'graphId', 'nodeId', 'nodeType', 'invocation']) if (own(event, key)) {
      const value = event[key];
      if (typeof value === 'string') entry[key] = clip(value, 120).text;
      else if (finite(value)) entry[key] = value;
    }
    if (own(event, 'error')) entry.error = errorSummary(event.error);
    for (const key of ['input', 'output']) if (own(event, key)) {
      const remaining = Math.max(0, budget.remaining - 250);
      if (remaining < 80) { entry[`${key}Omitted`] = true; continue; }
      const value = runtimeValue(event[key], Math.min(settings.maxTraceValueChars, remaining));
      const cost = JSON.stringify(value).length + 20;
      if (cost <= budget.remaining) { entry[key] = value; budget.remaining -= cost; }
      else entry[`${key}Omitted`] = true;
    }
    const metadataCost = JSON.stringify(entry).length - ['input', 'output'].reduce((sum, key) => sum + (entry[key] ? JSON.stringify(entry[key]).length : 0), 0);
    if (metadataCost > budget.remaining) break;
    budget.remaining -= metadataCost;
    selected.push(entry);
  }
  return { source: 'public-runtime-events', originalRuns: runs.length, originalEvents: events.length,
    events: selected, truncated: selected.length < events.length || selected.some(entry => entry.input?.truncated || entry.output?.truncated || entry.inputOmitted || entry.outputOmitted),
    selection: selected.length < events.length ? 'evenly-sampled-in-original-order' : 'complete' };
}

function costFeedback(evaluation, rows) {
  const known = key => finite(evaluation?.[key]) ? evaluation[key]
    : [...rows.values()].some(row => finite(row[key])) ? [...rows.values()].reduce((sum, row) => sum + (row[key] ?? 0), 0) : null;
  return { scope: 'recorded-evaluation-only-excludes-optimizer', inputTokens: known('inputTokens'), outputTokens: known('outputTokens'), totalTokens: known('totalTokens'),
    durationMs: finite(evaluation?.durationMs) ? evaluation.durationMs : null,
    providerAttempts: finite(evaluation?.providerAttemptCount) ? evaluation.providerAttemptCount : null,
    failedAttempts: finite(evaluation?.failedAttemptCount) ? evaluation.failedAttemptCount : null,
    usageStatus: ['complete', 'known-lower-bound'].includes(evaluation?.tokenUsageStatus) ? evaluation.tokenUsageStatus : 'unknown' };
}

/**
 * 为 history 中每个候选生成一份反馈：
 * sample/quality：评测题量与得分；paired：相对参考候选的改善和退步；
 * cases：代表题目、新旧答案及节点记录；cost/engineering：用量和执行错误。
 * 搜索入口将这些反馈交给优化模型，由模型决定下一轮改哪些提示词或流程。
 */
export function buildGeneratedFeedback(history, tasks, options = {}) {
  const settings = {
    maxCases: integerOption(options, 'maxCases', 6, 0, 6),
    maxPromptChars: integerOption(options, 'maxPromptChars', 4000, 100, 6000),
    maxPredictionChars: integerOption(options, 'maxPredictionChars', 350, 40, 2000),
    maxOutcomes: integerOption(options, 'maxOutcomes', 2, 1, 10),
    maxTraceCases: integerOption(options, 'maxTraceCases', 3, 0, 3),
    maxTraceEvents: integerOption(options, 'maxTraceEvents', 6, 1, 30),
    maxTraceValueChars: integerOption(options, 'maxTraceValueChars', 1200, 80, 2000),
    maxFeedbackChars: integerOption(options, 'maxFeedbackChars', 30000, 6000, 60000),
  };
  const publicTasks = new Map(tasks.map(task => [task.id, task]));
  const candidates = new Map(history.map(candidate => [candidate.id, candidate]));
  const rowsByCandidate = new Map(history.map(candidate => [candidate.id, publicRows(candidate, publicTasks)]));
  return history.map(record => {
    const rows = rowsByCandidate.get(record.id), groups = taskGroups(rows);
    const referenceId = record.referenceCandidateId ?? record.proposal?.referenceCandidateId ?? null;
    const reference = candidates.get(referenceId), referenceRows = rowsByCandidate.get(referenceId) ?? new Map();
    const paired = pairedFeedback(referenceId, rows, reference ? referenceRows : undefined);
    const choices = chooseCases(groups, taskGroups(referenceRows), paired, settings.maxCases);
    const failures = Object.fromEntries(FAILURE_KINDS.map(kind => [kind, [...rows.values()].filter(row => !row.valid && row.failureKind === kind).length]));
    const validRows = [...rows.values()].filter(row => row.valid);
    const result = {
      candidateId: record.id, status: record.status,
      sample: { publicTaskUniverse: publicTasks.size, observedTasks: new Set([...rows.values()].map(row => row.taskId)).size,
        observedRuns: rows.size, validRuns: validRows.length, invalidRuns: rows.size - validRows.length,
        declaredExamples: finite(record.evaluation?.examples) ? record.evaluation.examples : null,
        declaredRepeats: finite(record.evaluation?.repeats) ? record.evaluation.repeats : null },
      quality: { meanScore: mean(validRows.map(row => row.score)), meanTaskScore: mean([...groups.values()].map(group => mean(group.map(row => row.score)))),
        scope: 'observed-valid-runs-only', fullValidationClaim: false },
      paired: paired.summary, cost: costFeedback(record.evaluation, rows),
      cases: choices.map(choice => {
        const prompt = taskPrompt(text(publicTasks.get(choice.id).prompt), settings.maxPromptChars);
        return { taskId: choice.id, selectedBecause: choice.reason, prompt: prompt.text,
          promptTruncated: prompt.truncated, originalPromptLength: prompt.originalLength,
          current: outcomes(choice.rows, settings), reference: choice.prior.length ? outcomes(choice.prior, settings) : null,
          pairedMeanDelta: choice.pairedDelta };
      }),
      engineering: { failureCounts: failures, reportedIssueCount: record.engineeringFeedback?.length ?? 0,
        issues: (record.engineeringFeedback ?? []).slice(0, 5).map(errorSummary) },
      truncation: { applied: false, maxCharacters: settings.maxFeedbackChars, traceCaseLimit: settings.maxTraceCases },
    };
    // 先缩短案例中的文章，为节点记录留出空间，并保留末尾问题。
    const baseLimit = Math.max(4500, settings.maxFeedbackChars - 6000);
    while (JSON.stringify(result).length > baseLimit && result.cases.some(item => item.prompt.length > 900)) {
      for (const item of result.cases) if (item.prompt.length > 900) {
        const prompt = taskPrompt(text(publicTasks.get(item.taskId).prompt), Math.max(900, Math.floor(item.prompt.length * .8)));
        item.prompt = prompt.text; item.promptTruncated = prompt.truncated;
      }
    }
    // 当前候选的所有案例共用剩余字符额度，默认最多附上 3 道题的节点记录。
    const budget = { remaining: Math.max(0, settings.maxFeedbackChars - JSON.stringify(result).length - 1800) };
    for (let index = 0; index < Math.min(result.cases.length, settings.maxTraceCases); index++) {
      const item = result.cases[index];
      item.currentTrace = traceFor(record, item.taskId, settings, budget);
      item.referenceTrace = reference ? traceFor(reference, item.taskId, settings, budget) : null;
    }
    // 超过长度上限时，从后往前删减节点记录，再删减案例。
    while (JSON.stringify(result).length > settings.maxFeedbackChars && result.cases.some(item => item.currentTrace || item.referenceTrace)) {
      const item = [...result.cases].reverse().find(value => value.currentTrace || value.referenceTrace);
      item.currentTrace = null; item.referenceTrace = null; item.traceOmittedForBudget = true; result.truncation.applied = true;
    }
    while (JSON.stringify(result).length > settings.maxFeedbackChars && result.cases.length) { result.cases.pop(); result.truncation.applied = true; }
    result.truncation.applied ||= result.cases.some(item => item.promptTruncated || item.current.outcomesTruncated || item.reference?.outcomesTruncated
      || item.current.outcomes.some(value => value.predictionTruncated) || item.reference?.outcomes.some(value => value.predictionTruncated)
      || item.currentTrace?.truncated || item.referenceTrace?.truncated);
    return result;
  });
}

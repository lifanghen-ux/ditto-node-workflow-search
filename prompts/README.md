# Prompt ownership and maintenance

`optimizer-system.en.md` is the canonical cross-dataset optimizer system. Its version and expected SHA-256 are pinned in `src/unified/prompts.ts`; line endings are normalized before verification. Edits require an explicit protocol/version/hash update. Candidates cannot replace it.

Native reasoning operations have their own fixed system templates and the execution Agent's fixed contract. Different operations need not have identical text. Native parameter interpolation is audited; task instructions are not inserted into system messages. Ditto package files remain unchanged.

Candidate `instruction` fields, public tasks and output requirements are user data. The optimizer may change reusable task instructions, evidence organization, declared paths, queries and permitted criteria. It cannot rewrite the original task, scorer, system roles or permissions.

Retrieval's purpose, native schema and failure/permission semantics are fixed. A read-only host catalogue lists actual targets. User strategy can choose when to retrieve, query, `limit` and evidence consumption, but cannot expand the corpus. Retrieval need not invoke an LLM or have its own system prompt.

Each run freezes prompt versions/hashes and actual requests. Prompt, definition or helper changes create a new candidate identity requiring new evaluation. Source edits cannot alter a prior frozen run. Gold answers, private assertions and Test feedback are excluded from optimizer messages.

`npm run audit:prompts` checks these boundaries offline and makes no provider network calls.

## Generated workflow experiments

The standalone A experiment uses `expanded-search-prompts.zh-CN.md` for its generation contract, `a-evolution.zh-CN.md` for evolution guidance, and `dataset-initial-prompts.zh-CN.json` for task-specific capability reminders. These do not replace the canonical unified optimizer above.

Run `npm run experiment:a -- -Dataset drop -Fresh` after preparing the dependencies described in [the A experiment guide](../docs/a-evolution.md). Each task is evaluated once; generated A code is executed by Ditto Graph/Loop/Workers. The B executor remains available for historical runs.

`generated-search-feedback.mjs` builds paired validation feedback and bounded public execution traces. Private scorer state, gold answers and Test feedback stay outside optimizer input.

# MATH and AutomationBench engineering validation

This experiment consumes `@codesoul-co/ditto@0.1.1`. It does not patch Ditto Core
or installed dependencies. Its engineering protocol preserves the test sets:
119 MATH search cases and 200 AutomationBench simple search tasks; no test calls.
One initial workflow and at most two new candidates receive one search evaluation
each. Any additional repair regression reuses frozen candidate definitions.
See [the evidence-backed results](engineering-validation-results.md) for completed
scores, source identities and limitations.

## Environment and model calls

Use Node.js 24+, npm 11+, and a dedicated Python 3.13 environment:

```powershell
npm ci
python -m pip install -r requirements.txt
```

Set `DS_API_KEY` in the process environment. The default endpoint is
`https://api.deepseek.com`, model `deepseek-flash`. Point `DITTO_PROVIDER_PYTHON`
and `MATH_SCORER_PYTHON` at that environment's Python executable. Generic provider
overrides are optional; keys and local environment files must never be committed.

Every planner, optimizer, repair and tool-actor request uses temperature 0,
max_tokens 393216, n=1, text output, streaming and thinking disabled. `top_p` and
`reasoning_effort` are omitted. The model's output limit is a request setting,
not an estimate of actual consumption. Request attempts share one semaphore;
600-second request deadlines include finite transient HTTP retries. Authentication,
balance and parameter errors are not retried as transient failures. HTTP 429
honors bounded Retry-After or uses 10/20-second backoff, with a shared cooldown
within one provider bridge. Separate processes do not share that cooldown; run
datasets sequentially when the subscription rate limit is uncertain.

## Frozen data and graders

Reference MFlow revision: `437040f17a17cbf430f3f41227ca64c576cf1056`.
Clone the fixed references as siblings of this repository. On Windows, disable
line-ending conversion because MFlow verifies byte-level release hashes. Do not
edit manifests to make verification pass.

```powershell
git -c core.autocrlf=false clone https://github.com/erwinmsmith/MFlow.git ../MFlow
git -C ../MFlow checkout --detach 437040f17a17cbf430f3f41227ca64c576cf1056
git -c core.autocrlf=false clone https://github.com/zapier/AutomationBench.git ../AutomationBench-source
git -C ../AutomationBench-source checkout --detach 4a8e1061254004d9dac807054eed33fad7d1ff14
```

Reuse an existing checkout only after verifying its revision and clean source.

Prepare MATH with MFlow's published command, then extract its locked archive:

```powershell
python ../MFlow/benchmark-splits/splits.py prepare --benchmark math --download --out ../data/mflow-math
python scripts/prepare_math_data.py --archive ../data/.sources/aflow_data.tar.gz --out ../data/aflow
```

MATH prepends one common, answer-independent termination instruction to every
loaded problem. It asks the model to stop repeated verification and provide its
final answer; it imposes no numeric output/step cap. Raw dataset bytes, IDs and
grading remain unchanged. Report this repaired prompt separately from the original
raw-problem baseline; repeat all candidate evaluations after changing it.

MATH uses `math-verify==0.9.0`, ANTLR 4.13.2 and SymPy 1.14.0, with MFlow's
preprocessing and parse/verify semantics. The old AFlow normalization fallback is
retained for optional offline scorer comparison, but is not the active scoring
path. `scripts/compare_math_scorers.py --help` documents the read-only legacy
inputs and separate derived output; it never calls a model. On Windows,
math-verify's internal multiprocessing timeout is disabled; a supervising
30-second subprocess deadline provides interruption. Input is sent through stdin
to support long answers without the Windows command-line length limit. Truncated
generation is rejected before grading; partial answers are not scored. A scorer
exception is an engineering failure, never an incorrect answer.

For AutomationBench, pin the official source to
`4a8e1061254004d9dac807054eed33fad7d1ff14`. Install its frozen `uv.lock` into a
separate environment using `UV_PROJECT_ENVIRONMENT` and the official lock:

```powershell
$env:UV_PROJECT_ENVIRONMENT = Join-Path (Resolve-Path ..).Path ".venv-automation"
Push-Location ../AutomationBench-source
try { uv sync --frozen --no-dev } finally { Pop-Location }
$env:DITTO_AUTOMATION_ROOT = (Resolve-Path ../AutomationBench-source).Path
$env:DITTO_AUTOMATION_PYTHON = Join-Path $env:UV_PROJECT_ENVIRONMENT "Scripts/python.exe"
```

This PowerShell example uses a separate Windows Python environment. The official
modules must resolve from that checkout;
modified source, lockfiles, package identities or split hashes fail preflight.

Export using the official environment, then prepare the locked split:

```powershell
New-Item -ItemType Directory -Force ../data | Out-Null
Push-Location ../AutomationBench-source
try { & $env:DITTO_AUTOMATION_PYTHON ../MFlow/benchmark-hub/automation_bridge.py --export ../data/automationbench-export.jsonl } finally { Pop-Location }
python ../MFlow/benchmark-splits/splits.py prepare --benchmark automationbench --source ../data/automationbench-export.jsonl --out ../data/automationbench
```

This verifies the 200/600 public development
protocol, not the private leaderboard. Preparing test files does not authorize
test evaluation.

## Automation execution

The searched Context/Infer Graph/Loop produces a proposed plan. Each candidate
then uses the same native Runtime `runReactFlow` execution stage:
SAMPLE → INTERACTION.ACT.TOOL → INTERACTION.OBSERVE → SAMPLE. Tools are
`api_search`, `api_fetch`, and `base64_encode`, bound to the official simulated
world. This round searches planning structure, not tool-Node topology. In
particular, TRAJECTORY remains a reasoning Node and does not execute actions.

Each workflow attempt gets a fresh world; collaborators inside that attempt
share its world. The actor sees only public task text, tool schemas and tool
results. Snapshotting and assertion grading stay outside its scope. A fresh
grading world replays the saved snapshot and checks its contract hash. Strict
completion is 0/1; partial credit and assertion evidence are also retained.
Textual claims do not establish completion.

The bridge retains MFlow's official environment operations. Its only environment
adaptation relocates the generated API search index to a derived cache, preserving
the official source checkout. Tool argument mistakes remain model observations;
broken bridge/process/contract state invalidates the evaluation.

## Run only the approved search scope

```powershell
npm run build
node dist/cli.js search --dataset math --data-dir ../data/aflow --output-root ../runs/math --rounds 2 --repeats 1 --search-limit 0 --search-concurrency 3 --search-provider-concurrency 3
node dist/cli.js search --dataset automationbench --data-dir ../data/automationbench --output-root ../runs/automation --rounds 2 --repeats 1 --search-limit 0 --search-concurrency 3 --search-provider-concurrency 3
```

Run these commands sequentially. Concurrency 3 is a conservative starting point;
higher concurrency caused throttling during development. Adjust operational
concurrency after inspecting provider limits and local environment throughput. The
historical CLI defaults are larger formal-search defaults; the explicit flags
above are required for this engineering round. Do not start independent round
test watchers or invoke the `test` command during development.

## Validity, recovery and evidence

Wrong completed answers and unsatisfied official assertions are valid zeroes.
Provider, execution, parser and grader failures invalidate the candidate. The
internal numeric placeholder of an invalid summary is unusable: CLI scores are
null, and selection, convergence, experiences and backpropagation reject it.
No failed sample is removed from the denominator.

Malformed REFLECT responses receive at most two format-repair calls at the same
Node. Core validation is unchanged; no answer is coerced and no mathematical
grading decision is made by the repair model. Exhaustion remains invalid.

The search CLI's validation evaluator checkpoints every case. Its recovery
reuses valid completed cases only when model, data,
plan, execution code and protocol match. Lowering
concurrency preserves the identity and records both original and current
operational settings. Run only one process for an identical recovery identity.
After changing result-affecting code, run the affected frozen workflows again.
Code identity v2 normalizes CRLF to LF only in controlled UTF-8 source and
dependency text, so Git's LF checkout does not invalidate an identical program.
Real code, whitespace, BOM and binary changes remain significant. This rule does
not normalize datasets, raw traces or historical manifests. Identity-only repairs
retain the original search identity and a reviewed transition; they do not import
old case caches under a new identity.

Recovery is entry-point specific:

| Entry point | Supported recovery | Boundary |
| --- | --- | --- |
| `search` validation | Per-case recovery for incomplete evaluations; `--resume-dir` / `--resume-round` restores a completed search boundary | Same engine/data/plan/provider/protocol identity; no cross-version case import |
| `test:rounds` independent consumer | Restart queues failed, interrupted or legacy complete-but-invalid jobs again; a complete job is skipped only after validating its saved summary and samples | Whole-job retry, not per-case reuse. `src/round-test-runner.ts` is MATH-only and hard-codes `aflow-symbolic-plus-declared-answer-normalized-v3`; the current `mflow-math-verify-0.9.0` protocol is rejected by this entry point. It was not used for the retained test sets. Its job key has no engine hash: use a new output after source/environment changes |
| Ordinary final `test --run-dir` | Writes invalid test as failed with a null public score; valid wrong answers remain zero | No per-case checkpoint recovery or failed-manifest restart. Recovery for this entry point is deferred; do not edit a failed manifest to claim a successful resume |

Independent jobs retain each attempt's summary and samples before rejecting an
invalid evaluation. Their failed job has no final or legacy score. On restart,
old complete/zero metadata with invalid or incomplete evidence is retained under
the old attempt and retried as a whole job. Ordinary final test recovery remains
future work; these independent-runner changes do not provide that feature. The
independent class has completion/restart regression coverage, but the unchanged
CLI is not a usable test entry point for the current MFlow search protocol.

Set `DITTO_PROVIDER_LOG` to a local JSONL path to retain each HTTP attempt, raw
responses, partial failures, format repairs, usage and periodic stream progress.
Automation worlds and traces are saved under each run's `automation-worlds/`.
Known token totals are explicit lower bounds whenever any attempt lacks usage;
a failed execution with complete response usage still has known cost.

Standard answers, hidden tests, assertion details and private judge errors remain
in local evaluation records and are omitted from optimizer model requests.

## Acceptance and delivery

Freeze the selected workflow and source identity after all required search cases
are valid. Retain actual endpoint, model, prompt, input and scorer identities;
changing a configuration does not change an earlier run's provenance.

Deliver source, frozen workflow/configuration identities, result tables, evidence
references, reproduction steps and known limitations. Keep credentials, local
provider-specific development configuration, caches and verbose local evidence
outside the submitted source. Review the complete commit list, base/head and PR
text before submission.

Offline checks:

```powershell
npm run check
```

This also runs `acceptance/meeting-faults.test.mjs`. The acceptance matrix injects
401, 402, 429, timeout, 500 and scorer exceptions, then checks classification,
bounded retries, retained evidence, invalid-score isolation, failed-case-only
recovery and valid zeroes for ordinary wrong answers. Its Python fixture reuses
the existing SDK MockTransport and clock helpers; it makes no external requests.
These independent acceptance scripts do not change engine identity; their file
hashes belong to the delivery artifact and acceptance evidence.

`acceptance/http-workflow-faults.test.mjs` also runs a real loopback HTTP server
through the Python OpenAI SDK transport, published Ditto runtime, workflow,
native MFlow scorer and optimizer. It injects the same six fault classes, checks
actual HTTP/workflow retry counts and persisted provider records, rejects invalid
feedback/ranking, and recovers only the original failed sample while retaining a
valid zero. This test requires the provider and native scorer Python environments;
it uses a dummy local key and makes no external model calls.

The CI workflow installs Python 3.13 and the pinned requirements before running
`npm run check`, and enables the native MATH scorer. It supplies no model keys
or benchmark data. Official Automation-world checks are skipped there unless
the separate source/environment/data paths are configured; the complete local
94-test result uses those pinned paths and has no skips.

Native scorer and official-world tests require `MATH_SCORER_PYTHON`,
`DITTO_AUTOMATION_PYTHON`, `DITTO_AUTOMATION_ROOT` and `DITTO_AUTOMATION_DATA`.
They run no model calls or test-partition evaluations. Without those environment
settings, the native checks are explicitly skipped rather than reported passed.
`DITTO_AUTOMATION_DATA` is the directory containing the prepared `search.jsonl`,
for example `../data/automationbench`; use an absolute path when changing working
directories. The Automation Python executable belongs to its separate frozen
environment, rather than the provider/scorer environment.

Historical execution and current delivery identities remain separate. Decide
which checks to repeat from the affected execution path after a source change.
The independent round-test repair did not change search inference, provider or
scorer files. Relocating the Automation editable checkout changes its path-bearing
environment fingerprint; use a new output and never rewrite a recovery manifest.

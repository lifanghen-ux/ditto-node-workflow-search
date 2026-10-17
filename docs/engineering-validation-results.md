# Engineering validation results — 2026-10-17

This experiment validates MATH and AutomationBench execution and grading on
published Ditto 0.1.1. The formal results are full search evaluations of the
initial workflow and two candidates, one pass per structure. These are search
evaluation results, not independent test scores.

## Full search evaluation

| Dataset | Initial | Candidate 1 | Candidate 2 | Valid cases per structure |
| --- | --- | --- | --- | --- |
| MATH | 115/119 (96.64%) | 113/119 (94.96%) | 108/119 (90.76%) | 119/119 |
| AutomationBench | 190/200 (95.00%) | 188/200 (94.00%) | 188/200 (94.00%) | 200/200 |

Both selected the initial workflow. No improvement from the two added structures
was observed in this one-pass evaluation; it does not establish a repeated effect.
The full search runs used model `deepseek-v4.1-flash` at
`https://ark.cn-beijing.volces.com/api/plan/v3`. MATH ran at fingerprint
`3c28a965ed54ab338488019b9c64e95d6b290237ba1a012a5abbe728924ded6c`;
AutomationBench ran at
`2bc96521a74ec2f93834f30f8033e3644d8355c330983c9b9eafa853e089d088`.
Original manifests, complete per-case results and request logs retain those
actual execution identities. Operational recovery did not add a third candidate.

The current execution fingerprint is
`99adbc9ecd7caa1a7afc8662b804538c739ae091f35cc4626b04680bc6029582`.
Later engine changes address independent test-job handling and its regression
tests. Historical scores retain their actual execution identities; documentation
and packaging changes do not constitute new model runs.

## Recorded engineering checks

- Complete local `npm run check`: **94 passed, 0 failed, 0 skipped**, with the
  configured native graders.
- Fault injection covers 401, 402, 429, timeout, 500 and scorer exceptions.
  Real loopback HTTP tests exercise Python SDK, Ditto runtime, workflow, native
  MATH scoring and optimizer, checking retries and invalid-score isolation.
- Independent completion/restart regressions retain failed attempts, reject
  invalid or incomplete evidence and preserve valid wrong-answer zeroes.
- The earlier source archive passed npm ci, build and **41 key offline tests**,
  with no skips.
- Windows CI simulation passed **90 tests with 4 expected Automation-world skips**.
  CI installs pinned Python dependencies; hosted Linux GitHub Actions has not run.

Those logs retain the source/package identities on which they actually ran.
This documentation-only revision changes no execution code. Its new archive is
checked through document differences and file hashes; earlier test logs are not
presented as tests rerun on this archive.

## Evaluation and scope

MATH uses MFlow math-verify 0.9.0 preprocessing/equivalence without the previous
normalization fallback in the active scoring path. All candidates share one
answer-independent termination instruction. Long answers use stdin and a
30-second scorer subprocess deadline; truncated generation is rejected instead
of scoring partial output. Prompt or scoring changes do not establish a model
or search improvement.

Automation tools execute in independent official simulated worlds. Correctable
argument errors return observations so the model can repair the call. Broken
environment state or grader failures invalidate evaluation. Saved snapshots are
replayed in a separate grading session, and strict final-state assertions decide
success; a textual completion claim is insufficient.

Full search evaluated all 119 MATH search cases and 200 public simple Automation
tasks per structure. Neither test partition was model-evaluated: MATH 486 and
Automation 600 remain reserved. Automation search
varies planning structure before a common native ReAct tool stage, not the full
tool-Node topology. Ditto Core is unchanged.

Search validation can recover original failed cases
under a matching execution identity. The independent round-test class retries
whole jobs, but `src/round-test-runner.ts` remains MATH-only and requires the
hard-coded `aflow-symbolic-plus-declared-answer-normalized-v3` profile. It rejects
the current `mflow-math-verify-0.9.0` protocol, so it is not a usable test entry
point for current search runs. Ordinary final-test recovery remains deferred.

Missing usage remains unknown, not free. A recovered summary's elapsed time may
cover only its continuation. Relocation changes Automation's path-bearing
environment fingerprint and does not authorize rewriting recovery manifests.
Setup and supported entry points are in [the engineering guide](engineering-validation.md).

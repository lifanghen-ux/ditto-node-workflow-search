/** Frozen settings for the DeepSeek Flash MATH comparison. */
export const GENERATION = Object.freeze({ temperature: 0.2, topP: 1, maxTokens: 16_384 });
export const PROTOCOL = Object.freeze({
  id: "aflow-flash-math-v2",
  generation: GENERATION,
  thinking: "enabled (provider default in both arms)",
  reasoningEffort: "high (provider default in both arms)",
  searchRounds: 20,
  validationRepeats: 5,
  testRepeats: 3,
  selectionTopK: 4,
  selectionAlpha: 0.2,
  selectionLambda: 0.3,
  convergenceTopK: 3,
  convergenceZ: 0,
  convergenceConsecutiveRounds: 5,
  providerAttempts: 3,
  connectTimeoutMs: 5_000,
  readTimeoutMs: 600_000,
  workflowAttempts: 5,
  workflowRetryDelayMs: 1_000,
});

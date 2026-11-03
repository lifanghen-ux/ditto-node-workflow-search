import { loadProviderSettings } from '../dist/config.js';
import { createExperimentRuntime } from '../dist/ditto/runtime.js';
import { graph } from '@codesoul-co/ditto/runtime';
import { GENERATION } from '../dist/protocol.js';

// Exercise the same SDK transport and frozen generation settings as search.
let experiment;
try {
  const settings = loadProviderSettings();
  console.log(JSON.stringify({ phase: 'configuration', keyConfigured: true, model: settings.model }));
  experiment = createExperimentRuntime(settings);
  const plan = graph('provider-smoke').node('probe', 'INFER.REASONING.SAMPLE', [], () => ({
    model: { provider: experiment.providerName, model: experiment.model }, generation: GENERATION,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
  }));
  const result = await experiment.runtime.run(plan, {});
  const probe = result.probe;
  const passed = probe.status === 'success' && !!probe.output;
  console.log(JSON.stringify({ phase: 'provider-probe', passed, status: probe.status,
    errorCode: probe.error?.code, responsePresent: !!probe.output }));
  if (!passed) process.exitCode = 1;
} catch {
  // Do not print arbitrary provider exceptions or credentials.
  console.log(JSON.stringify({ phase: 'provider-probe', passed: false, reason: 'configuration-or-transport-failure' }));
  process.exitCode = 1;
} finally {
  await experiment?.close();
}

import { jsonrepair } from 'jsonrepair';

const tokens = text => text.match(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];

export function parseGeneratedProposal(content) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return { proposal: JSON.parse(text) }; }
  catch (originalError) {
    const repairedContent = jsonrepair(text);
    // Repair punctuation only; model-written strings and values must remain intact.
    if (JSON.stringify(tokens(text)) !== JSON.stringify(tokens(repairedContent))) throw originalError;
    return { proposal: JSON.parse(repairedContent), repairedContent };
  }
}

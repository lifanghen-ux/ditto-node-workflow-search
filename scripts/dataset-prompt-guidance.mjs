import {readFile} from 'node:fs/promises';
const poolUrl=new URL('../prompts/dataset-initial-prompts.zh-CN.json',import.meta.url);

export async function datasetPromptGuidance(dataset,availableTools=[]) {
  const pool=JSON.parse(await readFile(poolUrl,'utf8'));
  const profile=pool.datasets[dataset];
  if(!profile)return null;
  return {version:pool.version,dataset,usage:pool.usage,...profile,
    executionReminders:pool.executionReminders,availableTools:[...availableTools]};
}

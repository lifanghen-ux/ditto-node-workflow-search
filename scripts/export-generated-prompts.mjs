import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { GENERATED_SEARCH_PROMPT, GENERATED_SEARCH_PROMPT_VERSION, DROP_SEARCH_CONTRACT } from './generated-search-prompt.mjs';
import { GENERATED_A_GUIDE, GENERATED_A_GUIDE_VERSION } from './generated-workflow-a.mjs';
import { EVIDENCE_DEFINITION_GUIDE, EVIDENCE_DEFINITION_GUIDE_VERSION } from './generated-workflow-b.mjs';
import { SHARED_CAPABILITY_GUIDE } from './workflow-capabilities.mjs';

const destination=resolve(process.argv[2]??'docs/current-generated-prompts.md');
const sections=[
  ['本次自动调优使用的提示词',`以下英文内容直接从实际执行文件导出。核心提示词版本：${GENERATED_SEARCH_PROMPT_VERSION}。\n\n本次主要修改：开放 TRAJECTORY、DELIBERATE、REFLECT 的原生接口；模型自主选择是否使用；按实际内部调用计预算；最大验证阶段为 200 题。\n\n每次请求还会附上真实父候选、公开输入、得分和节点执行记录。它们按轮次变化，完整请求保存在每个运行目录的 proposals/*-request.json 中。`],
  ['1. 优化器系统提示词',GENERATED_SEARCH_PROMPT],
  ['2. DROP 任务要求',DROP_SEARCH_CONTRACT],
  ['3. 公共工具接口',SHARED_CAPABILITY_GUIDE],
  [`4. A 接口说明（${GENERATED_A_GUIDE_VERSION}）`,GENERATED_A_GUIDE],
  [`5. B 接口说明（${EVIDENCE_DEFINITION_GUIDE_VERSION}）`,EVIDENCE_DEFINITION_GUIDE],
];
await mkdir(dirname(destination),{recursive:true});
await writeFile(destination,sections.map(([title,body],i)=>`${i?'##':'#'} ${title}\n\n${i?'```text\n':''}${body}${i?'\n```':''}\n`).join('\n'),'utf8');
console.log(destination);

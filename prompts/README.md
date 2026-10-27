# 提示词

这里有两类提示词：**优化器提示词让模型改工作流，答题提示词让节点回答题目。**

一次搜索的过程是：初始工作流答题 → 程序评分并整理反馈 → 优化模型生成新工作流 → 再次答题评分。

A、B 的区别在于模型提交什么：A 提交完整 JavaScript 工作流代码；B 提交 JSON，写明节点、依赖和数据如何传递，由固定执行器运行。

| 文件 | 用途 |
| --- | --- |
| [expanded-search-prompts.zh-CN.md](expanded-search-prompts.zh-CN.md) | 实际读取的中文优化器提示词、任务要求和 A/B 接口说明。 |
| [candidate-prompts-200.zh-CN.md](candidate-prompts-200.zh-CN.md) | 实际读取的 A/B 初始答题提示词。 |
| [expanded-search-prompts.md](expanded-search-prompts.md) | 英文优化器与接口说明，供对照。 |
| [candidate-prompts-200.md](candidate-prompts-200.md) | 模型生成的英文答题提示词，供对照。 |
| [mflow-search-integrated.en.md](mflow-search-integrated.en.md) | MFlow 英文融合版，改动标黄，尚未接入运行。 |

编辑前两份文件、保存后，在项目目录运行：

```powershell
npm.cmd run experiment:user-prompts
```

程序依次运行 A、B，每路最多生成 2 个新候选，逐级评测至 200 题，每题一次。每路预算为 1,250 次请求、150 万 token；运行会产生 API 费用。

本轮输入保存在 `runs/user-prompts/<timestamp>/inputs/`。修改 Markdown 后需新开运行。初始结构来自 [模型生成的候选](../examples/generated-seeds)，替换提示词后重新评分。

安装和其他入口见 [运行说明](../docs/autonomous-workflow-changes.md)。

## 评测反馈在哪里整理

[`scripts/generated-search-feedback.mjs`](../scripts/generated-search-feedback.mjs) 同时服务于 A、B。它把已有评测结果整理给优化模型：

| 函数 | 做什么 |
| --- | --- |
| `pairedFeedback()` | 对比新旧候选在同一道题上的得分，统计改善、退步、持平。 |
| `chooseCases()` | 选取退步、低分、改善和答对的代表题目。 |
| `traceFor()` | 提取这些题目实际运行时的节点输入、输出和错误摘要。 |
| `buildGeneratedFeedback()` | 将得分、案例、节点记录和用量组成反馈，交给搜索入口。 |

例如某道题旧版得分为 1、新版为 0，反馈会列出两版答案和选中的节点记录。优化模型据此判断问题出在哪一步，再决定改答题提示词、节点连接或处理代码。

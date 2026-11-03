# A 工作流自进化实验

LLM 生成完整 JavaScript 模块，决定 Node、Graph、Loop、局部状态及停止条件。宿主负责接口校验、Ditto Worker 调用、数据集与评分器桥接、用量记录和评测反馈。入口是 `npm run experiment:a`；主线 unified search 入口保持独立。

## 安装与运行

需要 Node.js 24+、npm 11+、Python 3.11+，本地 `.env` 按 `.env.example` 填写。

```powershell
npm.cmd ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-provider.txt Pillow==11.3.0
$env:DITTO_PROVIDER_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
npm.cmd run experiment:a -- -Dataset drop -Fresh -FullSinglePass
```

`-Dataset` 支持 drop、humaneval、mbpp、bfcl、automationbench，另保留 math。模型、端点和生成参数使用项目配置。默认只生成一轮；每候选每题一次，阶段之间复用已有题次。`-FullSinglePass` 要求完成全集；请求或 token 预算仍然有效。运行会产生 API 费用。

数据准备沿用 [数据说明](../data/README.md)。HumanEval、MBPP 还需要预拉取 `python:3.13-slim`，只在无网络容器里执行候选 Python；Windows 可设置 `CODE_JUDGE_WSL_DISTRO` 使用 WSL Docker。MATH 另需固定版本 AFlow 评分依赖。

BFCL、AutomationBench 使用事先导出的 `data/<dataset>/search.jsonl`（200题），对应固定划分 ID 文件位于 `work/mflow-current/benchmark-splits/<dataset>/<protocol>/search.ids.json`。适配器校验 ID 顺序及上游 revision；数据与私有状态不入库。BFCL protocol 为 `bfcl-multiturn-family-v1`，AutomationBench 为 `automationbench-public-simple-v1`。

| 环境 | 上游 checkout | revision | Python 环境 |
| --- | --- | --- | --- |
| BFCL | `work/gorilla/berkeley-function-call-leaderboard` | `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8` | `work/bfcl-venv`，安装固定 checkout 的依赖 |
| AutomationBench | `work/AutomationBench` | `4a8e1061254004d9dac807054eed33fad7d1ff14` | 上游目录的 `.venv`，安装上游依赖 |

两个环境的 JSONL 工具桥接在 `scripts/official-*-bridge.py`。它们只提供当前公开工具及观察，评分留在宿主侧；不会把未来回合或私有世界状态交给候选。

## 提示词与搜索

- `prompts/expanded-search-prompts.zh-CN.md`：优化器、原生 Worker 接口和完整 A 模块契约。
- `prompts/a-evolution.zh-CN.md`：根据实际反馈修改流程、考虑质量与成本的指导。
- `prompts/dataset-initial-prompts.zh-CN.json`：五个数据集各六组可选提示词及能力提醒，不规定节点顺序。
- `prompts/*feedback-20261103.zh-CN.md`、`bfcl-followup-observations-20261103.zh-CN.md`：已观察到的公开执行问题，供后续生成参考。

LLM 可以改提示词、拓扑、数据传递和控制逻辑。完整有效候选进入质量/token 前沿；部分结果仅供诊断。相同源码即使更换名称或理由也不会再次付费评测。除完整评测模式外，阶段筛选会停止已经不可能超过指定目标的候选。

## 保存与恢复

运行目录在忽略的 `runs/a-evolution/` 下，保存配置、实际提示词、候选源码、逐题结果、公开节点轨迹和用量。每次运行生成 `workflow-report.png`；可用 `python scripts/render-workflow-report.py <run目录>` 重新绘图。

```powershell
npm.cmd run experiment:a -- -Dataset bfcl -ResumeRun <原运行目录> -ResumeCandidate <候选ID> -EvaluateOnly -FullSinglePass
```

恢复时核对模型、端点、生成参数、数据、题目顺序和源码，只补缺失或无效题次。Provider 故障即使被生成代码吞掉也不能计为有效评测。大历史文件保存轨迹位置，避免反复内嵌完整事件。

## 已保存的完整单次结果

[五个 LLM 生成模块及机器可读汇总](../examples/evaluated-workflows/results.json)。这些是 Search 集结果，每候选每题一次。请求和 token 为该候选有效题的执行用量，不含所有生成、失败和中断费用。

| 数据集 | 题数 | 指标 | 得分 |
| --- | ---: | --- | ---: |
| DROP | 200 | F1 | 90.262% |
| HumanEval | 33 | pass@1 | 93.939% |
| MBPP | 86 | pass@1 | 80.233% |
| AutomationBench | 200 | accuracy | 98.500% |
| BFCL | 200 | accuracy | 76.000% |

独立 Test 未运行。模块用于查看本次实际工作流，运行产物、原始题目、逐题答案及私有评分证据保留在本地。

## 本地检查

```powershell
npm.cmd run check
npm.cmd run test:generated
npm.cmd run audit:prompts
.venv/Scripts/python.exe scripts/provider_bridge_test.py
```

# 工作流验证与错误恢复

标准优化器和节点 system 保持不变。工作流继续由优化器生成；框架提供可执行检查、真实观察、错误反馈和同版本恢复能力。

## 可执行检查

- `public_python_check({source, entryPoint, checks})`：在隔离 Docker 中执行调用方提供的 Python 和 `check()`。返回实际异常、断言结果和耗时，不读取隐藏测试；任务关闭时取消并等待进程清理。
- `public_data_check`：`compare` 对传入的 `actual`、`target` 按 `relation` 比较；`select` 对 `rows:[{id,value}]` 筛选或排序，可按一开始计数的 `rank` 取项，并核对完整 `selection` 集合。并列名次或名次越界会报告问题；没有提供待核对集合时，不报告检查通过。
- `bfcl_respond` 可声明 `completionChecks:[{id,callIndex,path,relation,target}]`。`callIndex` 来自当前回合 `bfcl_call.executionEvidence`，`path` 是 JSON Pointer。框架读取真实观察值；条件失败不会向官方环境提交回合。旧回合或后续操作之前的观察不能作为当前完成证据。

这些能力需要工作流显式采用。框架检查所声明的条件，不能证明数据提取完整、目标符合题意或最终答案一定正确。未声明完成检查的既有工作流保持原有提交行为。

## 错误和证据

`PUBLIC_CHECK_FAILED` 区分“工具正常返回”和“自测通过”；`COMPLETION_CHECK_FAILED` 保留目标与实际状态差异；`TOOL_INPUT_PRECONDITION` 暴露无效工具参数。Graph 输出被 Loop 按错误形状读取时反馈 `LOOP_RESULT_SHAPE_MISMATCH`。

有限反馈窗口优先保留实际动作、异常、失败检查和新增退步，并保留成功对照。BFCL 的中间请求、真实函数参数、参数含义和返回形状单独保留；不把最终回答措辞当成业务执行评分依据。参考答案、隐藏断言和私有评分诊断不进入优化器。

文本转换可显式使用 `preserveNull:true`，防止缺失值成为字符串 `"null"` 并挡住后备答案。算术使用精确分数中间结果，最后转换为数值；非算术任务应跳过算术工具。

## 单次评测和恢复

`scripts/validate_official_search_small.mjs` 可选择公开 Search 诊断题和成功对照。每候选每题只做一次有效测量，诊断子集不作为全量准确率。

`scripts/repair_official_errors.mjs` 基于已测候选和真实公开轨迹生成修复候选。`--framework-upgrade true` 明确比较历史框架/候选与新框架/候选，并保留原始测量身份；它不构成同一执行版本下的工作流消融。

`scripts/complete_official_measurement.mjs --from-snapshot true` 校验并构建原始代码快照，只补相同执行身份下未完成的题。模型、生成参数、数据和评分协议需匹配，失败请求及累计用量不会清零。

代码评测在生成前检查隔离执行服务。只有评分器故障时可保留原预测重试评分；需要业务世界的任务仍必须提供原世界检查点。

## 提示词与验证

- 标准优化器：`prompts/official-optimizer-system.en.md`。
- 节点 system：`src/graph-agent/system.ts` 的 `NODE_SYSTEM_PROMPT`。
- Ditto 原生 REFLECT 与固定反思契约保持不变。新增能力通过工具目录公开。
- 执行模型和生成参数沿用固定配置：`deepseek-flash`、temperature 0、`maxTokens=393216`；优化器输出上限沿用 main 的 `OPTIMIZER_MAX_OUTPUT_TOKENS=16384`。
- 验证命令：`npm run check`、`node --experimental-vm-modules scripts/audit_official_prompts.mjs`。

本地验证包括代码崩溃复现、正常代码对照、排序与漏项检查、目标状态不符时拒绝提交、证据新鲜度、任务关闭取消、空值和精确算术、评分故障恢复，以及私有评分隔离。新增验证能力尚未完成新工作流的在线生成和数据集复测，不据此报告准确率提升。

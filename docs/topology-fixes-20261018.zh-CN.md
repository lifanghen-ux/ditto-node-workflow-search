# MATH 与 Automation 修改交付说明

本轮基于成员 PR #1（573644c24f0a1d9892f1431ade51865f6f07f7d5），按负责人确认的五项要求修改。此前的单次 search 评估结果保留为历史工程记录；本版搜索空间和协议已经改变，正式结果应重新搜索、再测试。

## 五项要求落地

1. **Token 耗尽按实际输出评测。** 完整收到的 `length` 输出继续解析、执行和评分，不因该标志重新生成。结构化节点收到完整合法 JSON 时正常使用；预算耗尽且无法满足节点格式时，按不可用答案正常评分。网络中断、流不完整、服务失败仍然无有效分数。保存实际服务结束原因。
2. **搜索与 Test 使用同一执行规则。** 记录并检查源码、实际编译产物、已安装 Ditto 代码、Node 版本、Python 环境、模型、端点、请求超时、生成协议和数据身份。选中后冻结完整流程及其哈希。源码改了却没重新构建、Test 改了评分环境或流程，均在调用前拒绝。每次候选评测前后再次检查身份。Test 的重复次数及选样规则也预先冻结。
3. **接口统一并检查调用方。** 恢复运行模块的 provider/tool/memory 注入和 provider 返回值，保留 PythonTransport 的 profile 调用形式，同时使用同一固定请求协议。另将本机旧 Automation 模块覆盖到整合源码中，执行编译检查；这只是兼容性验证，旧模块没有随本轮上传，也没有被新入口调用。
4. **搜索完整节点组织。** MATH 和 Automation 共用新的组织搜索入口。搜索能选择固定节点实例，调整分组、顺序、依赖、显式反馈、条件分支、重复及输出节点。节点配置、提示、工具实现和工具能力不由优化器生成。Automation 不再追加固定 ReAct 后半段，ACT、OBSERVE、UPDATE、OUTPUT 都在候选流程中。未接入的依赖不会自动进入模型输入。
5. **额外指导对齐固定基线源码。** 对照 MFlow `437040f17a17cbf430f3f41227ca64c576cf1056`：沿用 `finite-programs-v2` 的 Python/JSON 条件指导和同一重复工具诊断阈值及提示；Automation 公共任务指令逐字复用该版本。删除 Ditto 单独添加的 MATH“禁止自检、禁止替代解释”前缀。普通文本数学题不会因为公共包装自动获得 JSON/Python 限制。基线负责人的实际跑分 manifest 尚未提供，本说明确认的是上述固定源码版本，不能替代实际运行配置核对。

## 新搜索记录怎么读

`best/plan.json` 是最终执行依据，包含完整节点组织。`experiences.jsonl` 保存分数、与父候选的差值、组织方案和公开预测；参考答案及私有评分状态不会进入优化器请求。

每个搜索顶点仍标记一个真实变化节点或定位节点；现在允许重排完整组织，父子关系表示候选从何处改来，不能再用旧版“沿根到叶追加节点”来重建 MATH/Automation 流程。完整计划同时保存在 checkpoint 和恢复状态中。其余四个数据集仍保留原追加搜索入口，本轮未迁移。

节点之间有两种显式连线：`dependencies` 读取当前执行中已经可用的输入；`feedback` 读取已提交的前一次图执行结果，首次没有结果时可以为空。例如 UPDATE 的输出通过 feedback 回到 actor，才能让下一轮看见工具观察。搜索可以改变这些连线，执行器不会偷偷补上。

## 故障恢复

有效错误答案保持零分，不再生成。MATH 评分器出错后重评原答案；Automation 评分器出错后重评保存的原世界快照。真正的模型服务或环境故障仍保留失败记录并按既定重试规则恢复，不会把无有效评测的候选交给优化器。

正式 Test 支持原版本下的失败恢复：完整成功的样本直接复用，评分故障使用原答案/快照，服务故障重新处理原失败样本。已完成的正式 Test 禁止覆盖。搜索恢复使用最新发布的完整边界，旧版或不同源码的状态不能混入。

## 推荐运行顺序

1. 在本分支独立目录安装 npm 依赖和 requirements.txt 中的固定 Python 依赖；设置 `DITTO_PROVIDER_PYTHON`、`MATH_SCORER_PYTHON`。Automation 还需配置原工程指南中的官方环境、数据目录和 `DITTO_AUTOMATION_PYTHON`。
2. 执行 `npm run check`。本地回环测试如被系统代理影响，在测试进程设置 `NO_PROXY=127.0.0.1,localhost`。
3. 先由负责人亲自跑少量真实模型 smoke，核对工具轨迹、有效样本数和评分。再启动正式 search；正式 Test 只使用本轮冻结目录。
4. Search 与 Test 使用相同数据目录、模型配置及预先声明的 test 选样/重复参数；实验期间不改源码或评分环境。

示例（PowerShell，路径自行替换，正式参数保持默认）：

```powershell
npm run search:math -- --data-dir D:/data/math --output-root runs
npm run search:automationbench -- --data-dir D:/data/automationbench --output-root runs
node --env-file-if-exists=.env dist/cli.js test --dataset math --data-dir D:/data/math --run-dir <本轮冻结目录>
node --env-file-if-exists=.env dist/cli.js test --dataset automationbench --data-dir D:/data/automationbench --run-dir <本轮冻结目录>
```

## 验证范围

验证记录另附。测试模型均为本地模拟响应；MATH 联调使用实际锁定的 math-verify 评分器。没有启动付费模型全量实验，没有评测保留的真实 Test 集。Automation 官方世界测试是否运行，必须以测试报告中的环境说明和跳过数量为准，不能把模拟工具测试当作官方环境通过。

MFlow 复用代码的许可见 `third-party-licenses/MFlow.txt`。本轮未修改 Ditto npm 包和官方工具实现。

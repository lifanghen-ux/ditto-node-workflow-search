# 流程图

需要安装 Pillow。在项目目录运行：

```powershell
python scripts/render-workflow-report.py <run目录> --output outputs/workflow-report.png
```

可传入多个 run 目录进行对比。`--watch 5` 每五秒检查新结果，`--detailed` 输出详细版。

默认图显示方案、轮次、F1、题数、实际流程，以及该候选新增的评测调用和 token。包含优化器费用的总消耗见 `manifest.newUsage`。

节点和连线来自候选定义，分数来自评测摘要。图中分别标注缺失统计和执行错误。完整模块的最终输出标为 Loop 返回。

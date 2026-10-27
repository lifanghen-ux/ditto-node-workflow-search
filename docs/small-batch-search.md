# 小批量搜索协议

运行入口和代码见 [自动探索](autonomous-workflow-changes.md)。

| 参数 | 64 题 | 200 题 |
| --- | --- | --- |
| 阶段 | 16 → 32 → 64 | 16 → 32 → 64 → 128 → 200 |
| 重复次数 | 每题 1 次 | 每题 1 次 |
| 同题退步淘汰阈值 | 16题：15个百分点；32题：8个百分点 | 同左，另加64题：5个百分点；128题：3个百分点 |
| 达标 | 完整规模 F1 > 0.90 | 完整规模 F1 > 0.90 |

从固定的 200 题验证集按 seed=20261027 洗牌。A/B 共用清单，64题是200题的前缀。首题用于检查动态接口，成功结果计入后续阶段；每阶段只补新题。按表中阈值淘汰退步候选。

默认空历史入口上限为 6 个候选、500 次请求、150 万 token。预算包含优化器、修复和评测；SDK 重试与在途工作可能超额。HTTP 401/402/403 会停止运行，保留已完成记录。

历史缓存需显式传入 `--seed-run` 和 `--seed-candidate`，并通过数据、模型和结果完整性检查。`--offline-only true` 只准备清单或检查缓存。

## 补完与重复确认

`scripts/complete-small-batch-candidate.mjs` 默认仅补完未成功的题次。显式指定 `--repeats 3` 才执行冻结确认：

```powershell
node --env-file-if-exists=.env scripts/complete-small-batch-candidate.mjs --run-dir <目录> --candidate <ID> --repeats 3 --concurrency 3 --max-calls 280 --report <PNG路径>
```

确认结果写入原目录的 `confirmations/<ID>/`，新增消耗单独记录。`--offline-only true` 只检查缓存。

## 2026-10-27 结果

同一批64题，首次用于搜索，后两次只确认冻结候选：

| 方向 | 候选 | 第1次F1 | 第2次F1 | 第3次F1 | 平均F1 |
| --- | --- | ---: | ---: | ---: | ---: |
| A | generated-002 | 91.703% | 90.141% | 90.022% | 90.622% |
| B | generated-004 | 91.926% | 91.926% | 91.926% | 91.926% |

A 搜索目录：runs/generated-small-batch/drop/2026-10-27T10-45-36-347Z-A。
B 搜索目录：runs/generated-small-batch/drop/2026-10-27T10-39-00-236Z-B。

三次评测使用同一批64题。200题扩展结果见 [实验记录](expanded-infer-search.md)。

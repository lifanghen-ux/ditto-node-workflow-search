# 旧版 A/B 搜索

此页对应 `scripts/generated-workflow-search.mjs`。当前入口见 [自动探索](autonomous-workflow-changes.md)。

旧协议：完整 DROP 验证集 200 题，每题 5 次，默认最多 3 个有效候选；平均 F1 超过 0.85 时停止。工程失败另设尝试上限，用量仍计入。结果写入 `runs/generated-search/drop/`。

A 生成 JavaScript 模块，B 生成 JSON 定义。两者使用相同模型、Worker 和通用工具，由模型决定节点、提示词与控制逻辑。

恢复旧运行需同时指定 `--resume-run <目录>` 和 `--resume-candidate <ID>`。程序校验模型、数据和重复次数，只补未成功的题次。HTTP 401/402/403 会停止运行并保留记录。

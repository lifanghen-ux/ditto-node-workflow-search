# 本地安装与运行

需要 Node.js 24+ 与 Python 3.11+。在项目目录中运行：

```powershell
npm.cmd ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-local.txt
$env:DITTO_PROVIDER_PYTHON = "$PWD/.venv/Scripts/python.exe"
npm.cmd run check
npm.cmd run test:generated
```

按 `.env.example` 填写本地 `.env`，按 `data/README.md` 下载数据。

编辑 prompts/ 下的中文提示词后运行 `npm.cmd run experiment:user-prompts`，或阅读 [完整入口说明](docs/autonomous-workflow-changes.md)。运行费用由配置的模型服务收取。

原 CLI 仍可使用 run-local.ps1。MATH 还需要设置 AFLOW_REFERENCE_ROOT 指向固定版本 AFlow 源码；代码数据集需要 Docker。

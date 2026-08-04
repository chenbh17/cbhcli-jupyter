# RESEARCH：cbhcli-jupyter 技术方案调研报告

> 调研时间：2026-08-03 | 调研方式：联网搜索 + 阅读 cbhcli 源码 + 本地环境验证

---

## 一、环境确认

| 组件 | 版本 | 备注 |
|---|---|---|
| Python | 3.10.12 | |
| Node.js / npm | v22.23.1 / 10.9.8 | 满足前端构建要求 |
| JupyterLab | **4.4.5**（anaconda3 环境） | 目标版本（JupyterLab 4.x 系列） |
| jupyter_server | 2.17.0 | 后端扩展基于此 |
| jupyter_client | 8.8.0 | 内核通信 |
| cbhcli | 5.1.7（pip 已安装） | 后端逻辑复用源 |

**关键结论**：JupyterLab 4.x 中，扩展从 PyPI 安装后**自动触发前端编译**（`jupyter labextension build`），不再需要 JupyterLab 3 时代的 `jupyter labextension install` 手动流程。安装命令简化为 `pip install .`。

---

## 二、主流方案调研结论

### 2.1 JupyterLab 扩展开发的官方路径
- **官方模板**：`cookiecutter https://github.com/jupyterlab/extension-cookiecutter-ts`（可选 frontend / server / theme 三种，本项目选择 **frontend + server 结合**）；
- **官方示例仓库**：`jupyterlab/extension-examples`（含 hello-world、server-extension、kernel-output、react-widget 等标准示例）；
- **JupyterLab 4 打包**：`hatchling` + `hatch-jupyter-builder` 构建 hook，`npm` 前端产物预编译进 Python 包（`labextension/` 目录），用户侧零编译；
- **开发模式**：`pip install -e .` + `jupyter labextension develop . --overwrite`（前端改动热更新用 `jupyter labextension watch`）。

### 2.2 前端 + 后端双扩展架构（选定方案）
| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 纯前端扩展**（JS 直连 LLM API） | 简单 | ❌ 无法复用 cbhcli 的 Agent/工具/权限逻辑，不符合"复刻 cbhcli"要求 |
| **B. 前端扩展 + Python server extension**（✅ 选定） | 后端 100% 复用 cbhcli（ReAct/工具/权限/压缩/fallback），前端只做展示与 notebook 集成 | 需要维护前后端两套代码 |
| C. 外挂独立 FastAPI 服务 | 可整文件复用 web/server.py | ❌ 需单独起服务、跨端口 CORS、不符合"插件"形态 |

### 2.3 竞品架构参考
- **jupyter-ai**（官方）：左侧栏聊天图标 + Python server extension（LangChain 后端）+ 模型配置面板 + 选中代码提问。与本项目形态一致，已验证该架构成熟可行；
- **jupyter-chat**（官方）：纯前端聊天面板组件库（`@jupyter/chat`），提供消息渲染基础组件，可参考其聊天 UI 交互（本项目视觉以 cbhcli Web 为准，不依赖该库）；
- **jupyterlab-git**：经典的前端 + server extension 双扩展结构参考（`src/` + `jupyterlab_git/` + `jupyter-config/`）。

### 2.4 Notebook 操作 API（JupyterLab 4，前端侧）
- 跟踪当前活动 notebook：`INotebookTracker`（`currentWidget`）/ `app.shell.currentWidget`；
- 获取 cell：`notebook.model.cells.get(i)` → `cell.model.value`（读/写代码）、`cell.model.type`（code/markdown）；
- 选中 cell：`notebook.activeCell` / `notebook.model.selection`（`head`/`anchor`，支持多选区间）；
- 编辑器选区：`notebook.activeCell.editor.getSelection()` + `editor.model.value` 提取高亮文本；
- 执行 cell：`notebook.context.sessionContext.session.kernel.requestExecute({code})`，订阅 `iopub` 通道 `stream`/`execute_result`/`error` 消息获取输出；
- 插入/删除 cell：`notebook.model.cells.insert(index, cell)` / `notebook.model.cells.remove(index)`（CodeCellModel/CellModel.fromJSON）。

### 2.5 内核执行通道决策
| 通道 | 说明 | 结论 |
|---|---|---|
| 前端 `kernel.requestExecute` | 与 notebook 同内核、共享变量空间，UI 天然同步 | ✅ **选定**：notebook 工具统一走前端执行 |
| 后端 `jupyter_client` 连内核 | 需解析 connection file、处理消息协议，复杂度高 | 备选（若前端不可用可回退） |
| 后端子进程执行 | 无法共享 notebook 变量 | 仅作最终回退 |

**架构决策**：所有 notebook 操作（选中识别/编辑/执行/插入/删除/文件操作）通过**「后端 UI 任务队列 → 前端轮询执行 → 结果回传」**通道实现，后端不直接操作 UI/内核。

### 2.6 前后端通信协议
- **REST**：管理类 API（配置/模型/Agent/权限/历史）；
- **SSE（text/event-stream）**：聊天流式事件（对齐 cbhcli Web 的事件模型：reasoning/content/tool_confirm/tool_executing/tool_result/ask_user/compressing/compressed/fallback/error/aborted/done）；
- **UI 任务轮询**：notebook 工具专用，前端每 200ms 轮询 `/api/notebook/pending`，执行后回传结果。

### 2.7 快捷键安全策略（吸取用户历史教训）
- 前端**不注册任何全局 KeyBinding / addKeydownHandler**；
- 输入框使用原生 `textarea`，依赖浏览器原生复制粘贴；
- 中断操作只通过面板「停止」按钮；
- 不碰 JupyterLab 的 keyboard shortcuts 设置，不影响 notebook/终端快捷键。

---

## 三、最终技术方案（定稿）

```
cbhcli-jupyter/
├── pyproject.toml                    # hatchling + hatch-jupyter-builder（JupyterLab 4 标准）
├── package.json                      # 前端 npm 包 + jupyterlab builder 配置
├── tsconfig.json / tsconfig.base.json
├── install.json                      # labextension 元数据
├── README.md / docs/
├── src/                              # 前端 TypeScript
│   ├── index.ts                      # 插件入口：注册侧边栏图标 + 面板
│   ├── api.ts                        # REST + SSE 客户端（对齐 cbhcli Web API）
│   ├── widgets/
│   │   ├── chatPanel.ts              # 问答面板（复刻 cbhcli Web 聊天视图）
│   │   └── settingsPanel.ts          # 配置面板（模型/Agent/工具/权限/fallback）
│   ├── components/                   # 消息气泡/Markdown/工具卡片/输入框
│   └── notebook/
│       ├── nbClient.ts               # notebook 感知 + 选中识别 + UI 任务执行
│       └── nbApi.ts                  # 前端执行的 notebook 操作实现
├── style/                            # CSS（深色主题，对齐 cbhcli Web）
└── cbhcli_jupyter/                   # Python 后端（server extension）
    ├── __init__.py                   # ExtensionApp 注册
    ├── handlers.py                   # tornado handlers（REST + SSE）
    ├── chat_api.py                   # 复用 cbhcli_pkg.web.server 的会话/ReAct 循环
    ├── nb_tools.py                   # notebook 工具（UI 任务队列桥接）
    └── nb_task_queue.py              # UI 任务队列（创建/等待/超时/回传）
```

### 关键设计
1. **后端复用**：`from cbhcli_pkg.web.server import WebChatSession, _react_loop, _sse, _get_or_create_session, ...`，ReAct 循环、工具执行、权限、压缩、fallback 全部与 cbhcli Web 一致；
2. **notebook 工具注册**：会话创建后向 `tool_registry` 追加 notebook 工具（`nb_get_selection`/`nb_edit_cell`/`nb_execute_cell`/`nb_insert_cell`/`nb_delete_cell`/`nb_list_cells`/`nb_file_read`/`nb_file_edit`）；
3. **UI 任务桥**：notebook 工具执行 → 创建任务（UUID + 参数 + 超时 300s）→ 前端轮询获取 → 前端操作 notebook/内核 → 回传结果 → 工具返回；
4. **API 前缀**：`/cbhcli/`（避免与其他扩展冲突）；
5. **配置持久化**：复用 cbhcli 的 `GlobalConfig`（`~/.cbhcli/config.json`）与 Agent 工作空间，零迁移；
6. **构建与安装**：`pip install .` 一键完成（自动编译前端）；开发模式 `pip install -e .` + `jupyter labextension develop . --overwrite`。

### 验收映射
- ✅ 侧边栏图标 + 问答/配置面板
- ✅ 后端逻辑复刻 cbhcli（直接复用，行为一致）
- ✅ 前端视觉复刻 cbhcli Web（同款深色主题/消息气泡/工具卡片）
- ✅ notebook 工具 8 个 + 文件操作
- ✅ 快捷键零入侵（不注册全局快捷键）
- ✅ 安装/卸载干净（pip 包 + labextension 生命周期管理）

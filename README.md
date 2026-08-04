# cbhcli-jupyter

基于 [cbhcli](https://github.com/chenbh17/cbhcli)（v5.1.7）的 **JupyterLab AI 助手插件**：

- 🤖 **完整复刻 cbhcli Agent 能力**：ReAct 循环、Function Calling、工具调用、权限模式、上下文压缩、备用模型切换、死循环检测、hooks、检查点/undo、MCP、子 Agent 委托、Agent 链条
- 🎨 **前端对齐 cbhcli Web**：侧边栏问答面板（流式输出、思考过程、工具调用卡片、确认交互）+ 配置界面（模型/Agent/权限/备用模型/历史会话）
- 📓 **Notebook 深度集成**：识别选中代码块、修改/执行 cell、读取输出、插入/删除 cell、读写 JupyterLab 中打开的其他文件
- 🔒 **快捷键零入侵**：不注册任何全局快捷键，不影响 JupyterLab 终端与 notebook 的 Ctrl+C/Shift+Enter/Tab 等全部快捷键

## 环境要求

- Python 3.8+，JupyterLab ≥ 4.0
- 已安装 `cbhcli`（`pip install cbhcli`，版本 ≥ 5.1.7）

## 安装

```bash
pip install .            # 或 pip install cbhcli-jupyter（发布后）
# 安装完成后重启 JupyterLab
jupyter lab
```

JupyterLab 4 安装 Python 包后会自动构建/注册前端扩展，无需手动 `jupyter labextension install`。

安装后，JupyterLab **左侧栏**出现 cbhcli 图标，点击即可打开问答面板。

## 使用

### 问答
1. 打开左侧栏 cbhcli 面板；
2. 在顶部选择 **Agent** 与 **模型**（首次使用需先在「配置」中添加模型，填入 API Key / Base URL / 模型ID）；
3. 输入消息回车发送；AI 流式回复，工具调用过程以卡片展示（需确认时点「允许/拒绝/全部允许/永久允许」）；
4. 点「⏹ 停止」中断当前生成。

### Notebook 操作
打开任意 `.ipynb` 后，AI 可以使用以下工具直接操作 notebook（通过面板提问触发）：

| 工具 | 功能 |
|---|---|
| `nb_get_selection` | 获取当前选中代码/代码块（含 cell 内高亮选区） |
| `nb_list_cells` | 列出全部 cell 概览（代码 + 输出摘要） |
| `nb_edit_cell` | 修改指定 cell 代码（支持替换选中片段） |
| `nb_insert_cell` | 插入新 cell（AI 生成代码） |
| `nb_delete_cell` | 删除指定 cell |
| `nb_execute_cell` | 通过 notebook 内核执行代码（共享变量空间），返回输出 |
| `nb_file_read` | 读取 JupyterLab 打开的其他文件 |
| `nb_file_edit` | 修改 JupyterLab 打开的其他文件（整体/字符串/选中替换） |

> 例如：选中一段代码 → 面板问「解释这段代码」→ AI 调用 `nb_get_selection` 获取选中内容。

### 配置
面板「⚙️ 配置」Tab 支持：
- 模型管理（增删改、选择当前模型、embedding/rerank）
- Agent 选择、新建会话、手动压缩上下文
- 权限模式切换（readonly/standard/auto/yolo）
- 备用模型查看、历史会话恢复

## 架构

```
前端 (TypeScript)                    后端 (Python, jupyter_server 扩展)
┌─────────────────────┐             ┌──────────────────────────────────┐
│ 侧边栏面板 (问答/配置) │  REST/SSE   │  handlers.py (tornado)           │
│ notebook 集成 (选中/  │◄───────────►│  chat_api.py → 复用 cbhcli_pkg    │
│ 执行/文件操作)         │  200ms轮询   │  .web.server (WebChatSession /   │
│ nbClient 轮询任务队列  │            │  _react_loop 完全复用)            │
└─────────────────────┘             │  nb_tools.py (8个notebook工具)    │
                                    │  nb_task_queue.py (UI任务桥)      │
                                    └──────────────────────────────────┘
```

- 后端 100% 复用 `cbhcli_pkg.web.server`（ReAct 循环 / 工具注册 / 权限 / 压缩 / fallback 行为与 cbhcli Web 完全一致）；
- notebook 操作统一走「后端任务队列 → 前端执行 → 回传结果」通道（notebook 状态只存在于前端）；
- 快捷键安全：前端无任何全局 KeyBinding，输入框为原生 textarea，中断只通过按钮。

## 开发

```bash
npm install        # 前端依赖
npm run build:prod # 构建前端 + labextension 产物
pip install -e .   # 安装（开发模式）
```

前端改动热更新：`npm run watch:src` + `jupyter labextension watch .`

## 后端 API（前缀 /cbhcli/api）

| 端点 | 说明 |
|---|---|
| `POST /chat` | SSE 流式聊天（完整 ReAct 循环） |
| `POST /chat/respond` | 工具确认 / ask_user 应答 |
| `POST /chat/abort` · `POST /chat/reset` | 中断 · 重置会话 |
| `POST /chat/switch_model` · `POST /chat/compress` · `POST /chat/load` | 切换模型 · 压缩 · 加载历史 |
| `GET /chat/status` · `GET /chat/messages` | 会话状态 · 消息导出 |
| `GET/POST /models` · `/agents` · `/permissions` · `/fallback` · `/config` | 管理 API（对齐 cbhcli Web） |
| `GET /notebook/pending` · `POST /notebook/result` | notebook UI 任务桥 |

## 许可证

BSD-3-Clause

# 用户提示词：cbhcli-jupyter —— 基于 cbhcli 的 JupyterLab 插件

> 本文件是构建 `cbhcli-jupyter` 项目的完整需求说明。执行者须严格按本文件要求实施，先阅读全部内容，再动手。

---

## 一、项目概述

构建一个 **JupyterLab 插件** `cbhcli-jupyter`，将 AI 驱动的终端助手 **cbhcli**（v5.1.7）的能力嵌入 JupyterLab：

- **后端逻辑**（工具调用、Agent 逻辑、权限、压缩、回退等）**全部复刻 cbhcli** 源码内容；
- **前端显示**（问答界面、配置界面、交互方式）**全部复刻 cbhcli Web** 界面内容；
- 插件以 **侧边栏图标** 形式常驻 JupyterLab 左侧栏，点击图标可展开 **问答面板** 与 **各项配置设置**；
- 当 JupyterLab 中打开 `.ipynb` 文件时，插件能感知 notebook，**识别选中的代码/代码块**，并新增一组 **notebook 专用工具**（见第五节），实现「AI 直接操作 notebook 与文件」。

---

## 二、项目位置

- 项目根目录（新文件夹，已创建）：`/media/chenbh17/cbhssd/cbhcli/cbhcli-latest-Copy1/cbhcli-jupyter/`
- 所有源码、配置、文档均放在该目录内，不得污染 cbhcli 主项目。

---

## 三、参考代码（复刻来源，只读参照，不得修改）

| 复刻对象 | 位置 | 说明 |
|---|---|---|
| **cbhcli 核心逻辑** | `/media/chenbh17/cbhssd/cbhcli/cbhcli-latest-Copy1/cbhcli_pkg/core/` | ai_handler.py（ReAct循环/工具调用/自我反思/fallback）、agent.py、model.py（LLM客户端）、session.py（上下文/压缩目标）、tool_executor.py、permissions.py（权限引擎）、loop_detector.py、hooks.py、checkpoint.py、subagent.py、agent_chain.py、constants.py 等 |
| **cbhcli 工具模块** | `/media/chenbh17/cbhssd/cbhcli/cbhcli-latest-Copy1/cbhcli_pkg/tools/` | 内置 17 个工具（terminal/read/write/edit/python/grep/glob/Todo/ask_user/memory_search/knowledge_base/skills_create/delegate_task/image/call_agent 等），registry.py 工具注册中心 |
| **cbhcli 配置** | `/media/chenbh17/cbhssd/cbhcli/cbhcli-latest-Copy1/cbhcli_pkg/config/`、`commands/` | 全局配置（模型/嵌入/Agent/备用模型）、斜杠命令 |
| **cbhcli Web 界面** | `/media/chenbh17/cbhssd/cbhcli/cbhcli-latest-Copy1/cbhcli_pkg/web/` | server.py（FastAPI 后端 + WebChatSession + SSE 事件流）、static/（原生 JS SPA：聊天视图、模型配置、Agent 管理、fallback、skills、mcp、知识库、工具开关、历史、设置等 11 个视图） |
| **cbhcli 版本** | `cbhcli_pkg/__init__.py` | `__version__ = "5.1.7"` |

### 复刻策略（重要）
1. **后端**：优先 **直接 import 复用 `cbhcli_pkg` 包**（以 pip 已安装的 site-packages 为准，项目内可做薄封装层 `cbhcli_jupyter_server/`）；如需剥离/定制，再以源码为准复制修改，但必须保持核心逻辑（ReAct 循环、工具注册与执行、权限规则、上下文压缩、备用模型切换）**行为一致**。
2. **前端**：**复刻 cbhcli Web 的交互与视觉**——问答消息气泡（用户/AI）、Markdown 渲染、图片缩略图、流式输出、配置表单、深色主题；适配 JupyterLab 的 UI 框架（@jupyterlab/ui-components 或直接注入 HTML/CSS）。
3. 任何对 cbhcli 主项目的改动都不被允许；复刻过程中发现的 cbhcli 问题只记录、不改。

---

## 四、功能需求

### 4.1 总体架构（推荐，须先联网调研确认主流方案后再定稿）
- **JupyterLab 3.x+ 插件标准结构**：前端 TypeScript 扩展（`src/`）+ 后端 Python Server Extension（`jupyter_server` 扩展，提供 REST API / WebSocket），打包为 `pyproject.toml` + `package.json` 的现代扩展格式（`jupyter labextension develop` 或 `pip install -e .` + `jupyter labextension install`）。
- **前后端通信**：REST API 为主 + SSE/WebSocket 推送流式输出（参考 cbhcli Web 的 SSE 事件模型：reasoning/content/tool_confirm/tool_executing/tool_result/ask_user/compressing/compressed/fallback/error/aborted/done）。
- **Agent 会话运行在 Jupyter 服务器进程内**（Python 后端），前端只负责展示与交互。

### 4.2 后端（Agent 逻辑 —— 复刻 cbhcli）
- 完整复刻 cbhcli 的 Agent 能力：ReAct 循环、Function Calling、工具注册与执行（含确认/预览/重试）、自我反思、上下文管理（token 精确计算 + 自动压缩 + 手动压缩）、主模型 fallback、权限模式（readonly/standard/auto/yolo）、死循环检测、hooks、检查点/undo、MCP 工具、子 Agent 委托（delegate_task）、Agent 链条（call_agent）。
- 模型配置：与 cbhcli 兼容（API Key/Base URL/模型ID/thinking/reasoning_effort/max_tokens/embedding/rerank），支持多模型管理与备用模型。
- 工作空间：复用 cbhcli 的 Agent 工作空间机制（`~/.cbhcli/agents/<name>/`），或提供插件内建的独立配置目录，二者可切换。
- **新增 notebook 工具**（第五节）。

### 4.3 前端（显示与交互 —— 复刻 cbhcli Web）
- **问答面板**：用户输入框 + 消息流式展示 + Markdown 渲染 + 思考过程展示 + 工具调用过程展示（含确认弹窗、执行状态、结果预览）、错误提示、停止按钮。视觉与交互对齐 cbhcli Web。
- **配置界面**：点击侧边栏图标打开，包含（对齐 cbhcli Web 各视图）：
  - 模型配置（增删改、切换当前模型、embedding/rerank）
  - Agent 管理（工作空间选择）
  - fallback 备用模型管理
  - 工具开关（内置工具/MCP 工具）
  - 权限模式设置
  - 历史会话查看/恢复
  - 插件自身设置（侧边栏行为、notebook 集成开关等）
- 支持多语言/中文界面（对齐 cbhcli Web）。

### 4.4 侧边栏集成
- 在 JupyterLab **左侧栏添加图标**（如 SVG 图标，可与 cbhcli 品牌一致），点击后打开可停靠面板（`SideBar`/`Panel`），面板内含问答视图与配置入口（可 Tab 切换或二级导航）。
- 侧边栏面板应可拖拽宽度、可关闭，不干扰 JupyterLab 其他面板。

### 4.5 Notebook 集成与 notebook 专用工具（核心亮点）
当 JupyterLab 中打开 `.ipynb` 时，插件须：

1. **感知与定位**：
   - 监听当前活动 widget（`app.shell.currentWidget`），识别 notebook 实例；
   - **识别选中的代码块**：编辑模式下的光标所在 cell、命令模式下的选中 cell、多选 cell、cell 内高亮选中的代码片段（选区文本），都能被准确捕获并传给 Agent；
   - 感知 notebook 文件路径与所在内核（kernel）状态。

2. **新增 notebook 工具**（注册到 Agent 工具列表，仅在有 notebook 打开时可用），至少包括：
   - `nb_get_selection`：获取当前选中的代码/代码块内容（含 cell 索引、cell id、选区文本）；
   - `nb_edit_cell`：修改指定 cell 的代码内容（或替换选中的代码片段）；
   - `nb_execute_cell`：执行指定 cell（通过 notebook 内核执行），并**识别输出结果**（stdout/stderr/执行结果/异常/富输出）返回给 Agent；
   - `nb_insert_cell`：在指定位置插入新代码 cell（含 AI 生成的代码）；
   - `nb_delete_cell`：删除指定 cell；
   - `nb_list_cells`：列出 notebook 全部 cell 的概览（类型/索引/代码摘要/输出摘要）；
   - `nb_switch_kernel` / `nb_kernel_status`：内核管理（可选）；
   - `nb_file_edit` / `nb_file_read`：**修改/读取 JupyterLab 中打开的其他文件**（如 .py/.md/.txt 等文本文件，含文件选中内容替换）；
   - 工具结果需以结构化 JSON 返回，支持把 notebook cell 内容、文件内容作为上下文注入 Agent 会话。
3. **执行方式**：notebook 代码执行尽量走 **Jupyter 内核协议**（`jupyter_client`），保持与 notebook 会话同一内核、共享变量空间；若目标内核不可用，则回退到子进程执行并注明差异。
4. **UI 反馈**：AI 修改/执行 cell 后，前端面板与 notebook 实时同步（cell 内容更新、输出区刷新），必要时在 notebook 中高亮被操作的 cell。

### 4.6 联网调研（实施前置步骤）
- 开工前须联网搜索并归纳主流 JupyterLab 插件实现方案，包括但不限于：
  - 官方扩展开发文档（extension development 教程、cookiecutter 模板 `jupyterlab/extension-cookiecutter-ts`）；
  - 前后端分离架构（TypeScript 前端扩展 + Python server extension）与单前端扩展方案的取舍；
  - 操作 notebook/cell/output 的官方 API（`@jupyterlab/notebook`、`@jupyterlab/cells`、`@jupyterlab/outputarea`、`INotebookTracker`、`Cell.model.value`、`kernel.requestExecute`）；
  - 类似竞品参考（如 jupyter-ai、jupyterlab-git、jupyterlab 内嵌聊天类插件）的架构与交互；
  - 现代打包方式（`hatchling`/`setuptools` + `jupyter labextension build`）。
- 调研结论写入项目文档 `docs/RESEARCH.md`，并据此确定最终技术方案。

---

## 五、快捷键与终端兼容（⚠️ 最高优先级要求）

用户此前安装自定义插件后，在 JupyterLab 内启动 cbhcli（CLI 模式）问答过程中 **Ctrl+C 失效**。本插件必须杜绝此类问题：

1. **插件不得注册任何全局键盘快捷键**（不调用 `addKeydownHandler`、不注册 `KeyBinding`），除非该快捷键仅在插件自身侧边栏面板获得焦点时生效。
2. **不得拦截/覆盖 JupyterLab 现有快捷键**：包括但不限于 `Ctrl+C`（复制/中断）、`Ctrl+V`、`Ctrl+Z`、`Shift+Enter`（执行 cell）、`Ctrl+Enter`、`Esc`、`Tab` 补全等。notebook 的编辑模式/命令模式快捷键、终端（Terminal）的快捷键全部保持原样。
3. **插件内输入框**：若需要粘贴/复制快捷键，只依赖浏览器原生行为，不自定义 keydown 处理；输入框失焦后不得持有任何按键监听。
4. **后端执行中断**：AI 生成/工具执行的中断操作只通过**面板内的「停止」按钮**或面板聚焦时的自定义按键实现，不得监听全局 Ctrl+C。
5. **验收硬性标准**（安装后必须逐项验证）：
   - JupyterLab 终端（Terminal）内 `Ctrl+C` 可正常中断前台命令；
   - notebook 编辑模式 `Ctrl+C` 复制、命令模式 `Ctrl+C` 复制 cell 均正常；
   - `Shift+Enter` 执行 cell、`Tab` 补全不受影响；
   - 插件面板打开/关闭/聚焦/失焦各状态下，以上快捷键均不受影响。

---

## 六、实施步骤（建议顺序）

1. 联网调研（4.6），产出 `docs/RESEARCH.md` 并确定技术方案；
2. 搭建项目骨架（前端扩展 + 后端 server extension + 打包配置），跑通最小可运行插件（侧边栏出现图标）；
3. 后端接入 cbhcli 核心（复用 `cbhcli_pkg`，跑通「问答 → ReAct → 工具执行」完整链路，可用内置工具验证）；
4. 前端复刻 cbhcli Web 问答界面与配置界面（消息流式展示、工具调用过程、配置表单）；
5. 实现 notebook 集成与 notebook 工具（选中识别 → 编辑/执行/输出识别 → 文件操作），联调实时同步；
6. 快捷键兼容性全面测试（第五节验收标准）；
7. 完善打包/安装流程（pip 安装 + labextension 安装或预编译分发），编写 README 与使用文档；
8. 端到端验收。

## 七、交付物与验收标准

### 交付物
- 完整项目源码（前端 + 后端 + 打包配置 + 测试）；
- `README.md`（安装/使用/开发说明）；
- `docs/RESEARCH.md`（调研结论与技术方案）；
- 安装包（whl + labextension 产物），一条命令可安装启用。

### 验收标准
1. `pip install` + 启用后，JupyterLab 左侧栏出现 cbhcli 图标，点击打开面板；
2. 面板内可与 AI 正常问答，流式输出、工具调用（内置工具 + notebook 工具）全部可用，交互与 cbhcli Web 一致；
3. 配置界面可完成模型/Agent/工具/权限/备用模型等全部配置，配置持久化；
4. 打开 .ipynb 后，AI 能识别选中代码块并执行「修改、执行、读输出、操作其他文件」等操作，notebook 界面实时同步；
5. 第五节快捷键验收标准全部通过；
6. 与 cbhcli 主项目零冲突：不修改 cbhcli 源码，卸载插件后 JupyterLab 完全还原。

## 八、注意事项
- 全程中文注释与文档；代码风格对齐 cbhcli 主项目；
- 依赖尽量复用 cbhcli 已有依赖，避免引入过重框架；
- 每个里程碑完成后向用户汇报进度与验证结果；
- 遇到 cbhcli 主项目相关疑问时，可参考其源码与文档（`docs/` 目录下有各版本更新日志），但不得修改主项目。

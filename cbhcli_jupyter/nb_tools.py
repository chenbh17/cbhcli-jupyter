"""notebook 专用工具：通过 UI 任务队列桥接到 JupyterLab 前端执行。

工具清单（仅当 JupyterLab 中有 notebook 打开时才有意义）：
- nb_get_selection : 获取当前选中的代码/代码块（cell 索引、cell id、代码、选区文本）
- nb_list_cells    : 列出 notebook 全部 cell 概览（类型/索引/代码摘要/输出摘要）
- nb_edit_cell     : 修改指定 cell 的代码内容（或替换选中的代码片段）
- nb_insert_cell   : 在指定位置插入新 cell（AI 生成代码）
- nb_delete_cell   : 删除指定 cell
- nb_execute_cell  : 执行指定 cell（通过 notebook 内核，共享变量空间），返回输出
- nb_file_read     : 读取 JupyterLab 中打开的其他文件（.py/.md/.txt 等）
- nb_file_edit     : 修改 JupyterLab 中打开的其他文件（支持全文替换/选中内容替换）

执行方式：所有操作都在前端执行（notebook UI / 内核 requestExecute），
后端只创建 UI 任务并等待结果。若前端不可用（JupyterLab 未打开/面板未激活），
任务将超时失败并返回明确提示。
"""

import json
from typing import Optional

from cbhcli_pkg.tools.registry import BaseTool, ToolResult

from .nb_task_queue import task_queue

# 前端执行超时（秒）。代码执行可能较慢，给足时间。
DEFAULT_TIMEOUT = 300.0
# 简单工具超时
QUICK_TIMEOUT = 30.0


def _run_ui_action(action: str, params: dict, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """创建 UI 任务并等待前端执行结果。"""
    task = task_queue.create(action, params, timeout=timeout)
    return task.wait()


def _to_tool_result(result: dict) -> ToolResult:
    """把前端返回的结构化结果包装为 ToolResult。

    前端结果约定：{"success": bool, "output": str, "error": str, "data": {...}}
    """
    if not isinstance(result, dict):
        return ToolResult(
            success=False, output="",
            error=f"前端返回异常结果: {result!r}")
    success = bool(result.get("success"))
    output = result.get("output") or ""
    error = result.get("error") or ""
    data = result.get("data") or {}
    if success:
        return ToolResult(
            success=True, output=output,
            metadata={"data": data} if data else None)
    return ToolResult(success=False, output="", error=error or output or "未知错误")


def _cell_loc(cell_index=None, cell_id=None) -> dict:
    """统一 cell 定位参数。"""
    params = {}
    if cell_index is not None:
        params["cell_index"] = int(cell_index)
    if cell_id:
        params["cell_id"] = str(cell_id)
    return params


# ---------------------------------------------------------------------------
#  1. nb_get_selection
# ---------------------------------------------------------------------------

class NbGetSelectionTool(BaseTool):
    name = "nb_get_selection"

    description = (
        "获取 JupyterLab 中当前打开的 notebook 的选中内容。"
        "返回：活动 cell 的索引/id/类型/代码，cell 内高亮选中的代码片段（若有），"
        "以及命令模式下选中的多个 cell 列表。"
        "在 AI 需要理解用户当前正在编辑的代码、或需要基于选中代码执行操作时使用。"
        "注意：仅当 JupyterLab 中有 notebook 打开并聚焦时可用。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "include_outputs": {
                    "type": "boolean",
                    "description": "是否同时返回活动 cell 的输出摘要（默认 false）",
                },
            },
            "required": [],
        }

    def execute(self, include_outputs: bool = False, **kwargs) -> ToolResult:
        result = _run_ui_action(
            "nb_get_selection", {"include_outputs": bool(include_outputs)},
            timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  2. nb_list_cells
# ---------------------------------------------------------------------------

class NbListCellsTool(BaseTool):
    name = "nb_list_cells"

    description = (
        "列出 JupyterLab 中当前打开的 notebook 的全部 cell 概览："
        "每个 cell 的索引、id、类型（code/markdown）、代码内容（截断）与输出摘要。"
        "适合 AI 需要了解整个 notebook 结构、定位特定代码时使用。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "max_code_chars": {
                    "type": "integer",
                    "description": "每个 cell 代码最多返回的字符数（默认 500，超出截断）",
                },
                "max_output_chars": {
                    "type": "integer",
                    "description": "每个 cell 输出最多返回的字符数（默认 300，超出截断）",
                },
                "include_outputs": {
                    "type": "boolean",
                    "description": "是否包含 cell 输出摘要（默认 true）",
                },
            },
            "required": [],
        }

    def execute(self, max_code_chars: int = 500, max_output_chars: int = 300,
                include_outputs: bool = True, **kwargs) -> ToolResult:
        result = _run_ui_action("nb_list_cells", {
            "max_code_chars": int(max_code_chars),
            "max_output_chars": int(max_output_chars),
            "include_outputs": bool(include_outputs),
        }, timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  3. nb_edit_cell
# ---------------------------------------------------------------------------

class NbEditCellTool(BaseTool):
    name = "nb_edit_cell"

    description = (
        "修改 JupyterLab 中当前打开的 notebook 的指定 cell 的代码内容。"
        "可按 cell_index 或 cell_id 定位 cell；若提供 selection_text（须与 cell 内现有文本完全一致），"
        "则只替换 cell 中选中的/指定的代码片段，否则整体替换 cell 内容。"
        "修改后 notebook 界面实时同步（无需保存）。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "cell_index": {
                    "type": "integer",
                    "description": "目标 cell 的索引（从 0 开始），与 cell_id 二选一",
                },
                "cell_id": {
                    "type": "string",
                    "description": "目标 cell 的 id，与 cell_index 二选一",
                },
                "new_code": {
                    "type": "string",
                    "description": "新的代码内容；未提供 selection_text 时整体替换 cell",
                },
                "selection_text": {
                    "type": "string",
                    "description": "（可选）要替换的现有代码片段，必须与 cell 内文本完全一致；"
                                     "提供时仅替换该片段",
                },
                "cell_type": {
                    "type": "string",
                    "enum": ["code", "markdown"],
                    "description": "（可选）同时修改 cell 类型",
                },
                "insert_at_line": {
                    "type": "integer",
                    "description": "（可选）在此行号（1-based）附近插入 new_code 作为新行（不替换现有内容）。"
                                   "用于在用户光标处添加代码；与 selection_text 互斥，优先于整体替换",
                },
                "insert_at_col": {
                    "type": "integer",
                    "description": "（可选）配合 insert_at_line 的光标列号（1-based）：列=1 插到该行上方，"
                                   "列>1 插到该行下方。缺省按行首处理",
                },
            },
            "required": ["new_code"],
        }

    def execute(self, new_code: str, cell_index=None, cell_id=None,
                selection_text: Optional[str] = None,
                cell_type: Optional[str] = None,
                insert_at_line: Optional[int] = None,
                insert_at_col: Optional[int] = None, **kwargs) -> ToolResult:
        if not new_code:
            return ToolResult(success=False, output="", error="必须提供 new_code 参数")
        params = _cell_loc(cell_index, cell_id)
        params["new_code"] = new_code
        if insert_at_line is not None:
            params["insert_at_line"] = int(insert_at_line)
            if insert_at_col is not None:
                params["insert_at_col"] = int(insert_at_col)
        elif selection_text is not None:
            params["selection_text"] = selection_text
        if cell_type:
            params["cell_type"] = cell_type
        result = _run_ui_action("nb_edit_cell", params, timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  4. nb_insert_cell
# ---------------------------------------------------------------------------

class NbInsertCellTool(BaseTool):
    name = "nb_insert_cell"

    description = (
        "在 JupyterLab 中当前打开的 notebook 的指定位置插入一个新的 cell（代码或 markdown）。"
        "插入后自动成为活动 cell，界面实时同步。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "cell_index": {
                    "type": "integer",
                    "description": "插入位置（从 0 开始，默认在当前活动 cell 之后）",
                },
                "code": {
                    "type": "string",
                    "description": "新 cell 的内容（代码或 markdown 文本）",
                },
                "cell_type": {
                    "type": "string",
                    "enum": ["code", "markdown"],
                    "description": "cell 类型，默认 code",
                },
                "execute": {
                    "type": "boolean",
                    "description": "插入后是否立即执行（默认 false）",
                },
            },
            "required": ["code"],
        }

    def execute(self, code: str, cell_index=None, cell_type: str = "code",
                execute: bool = False, **kwargs) -> ToolResult:
        if not code:
            return ToolResult(success=False, output="", error="必须提供 code 参数")
        params = {"code": code, "cell_type": cell_type, "execute": bool(execute)}
        if cell_index is not None:
            params["cell_index"] = int(cell_index)
        result = _run_ui_action("nb_insert_cell", params, timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  5. nb_delete_cell
# ---------------------------------------------------------------------------

class NbDeleteCellTool(BaseTool):
    name = "nb_delete_cell"

    description = (
        "删除 JupyterLab 中当前打开的 notebook 的指定 cell。"
        "可按 cell_index 或 cell_id 定位；不传参数时删除当前活动 cell。"
        "注意：删除不可撤销，请谨慎使用（notebook 会在关闭时要求保存确认）。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "cell_index": {
                    "type": "integer",
                    "description": "要删除的 cell 索引（从 0 开始）",
                },
                "cell_id": {
                    "type": "string",
                    "description": "要删除的 cell id",
                },
            },
            "required": [],
        }

    def execute(self, cell_index=None, cell_id=None, **kwargs) -> ToolResult:
        params = _cell_loc(cell_index, cell_id)
        result = _run_ui_action("nb_delete_cell", params, timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  6. nb_execute_cell
# ---------------------------------------------------------------------------

class NbExecuteCellTool(BaseTool):
    name = "nb_execute_cell"

    description = (
        "在 JupyterLab 中当前打开的 notebook 的内核中执行代码并返回输出结果。"
        "支持三种方式："
        "1. 传 cell_index/cell_id：执行 notebook 中已有 cell（其内容将被执行）；"
        "2. 传 code：直接执行一段代码（不写入 notebook，适合临时验证）；"
        "3. 两者都传：把 code 写入指定 cell 后执行（即修改+执行）。"
        "执行结果包含 stdout/stderr/执行结果/异常信息，与 notebook 共享变量空间。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "cell_index": {
                    "type": "integer",
                    "description": "要执行的 cell 索引（从 0 开始），与 cell_id 二选一",
                },
                "cell_id": {
                    "type": "string",
                    "description": "要执行的 cell id",
                },
                "code": {
                    "type": "string",
                    "description": "（可选）直接执行的代码；与 cell 定位同传时先写入 cell 再执行",
                },
                "timeout": {
                    "type": "integer",
                    "description": "执行超时（秒，默认 300）",
                },
            },
            "required": [],
        }

    def execute(self, cell_index=None, cell_id=None, code: Optional[str] = None,
                timeout: int = DEFAULT_TIMEOUT, **kwargs) -> ToolResult:
        params = _cell_loc(cell_index, cell_id)
        if code:
            params["code"] = code
        result = _run_ui_action("nb_execute_cell", params, timeout=float(timeout))
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  7. nb_file_read
# ---------------------------------------------------------------------------

class NbFileReadTool(BaseTool):
    name = "nb_file_read"

    description = (
        "读取 JupyterLab 中打开的其他文件（.py/.md/.txt/.json/.csv 等文本文件）的内容。"
        "支持按文件路径读取，也可按当前打开的文件名定位。"
        "读取的是 JupyterLab 编辑器中打开的文件（与磁盘同步的最新内容）。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径（绝对路径或相对 JupyterLab 工作目录的路径）",
                },
                "filename": {
                    "type": "string",
                    "description": "按文件名匹配当前打开的编辑器文件（不区分目录），与 path 二选一",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "最多返回的字符数（默认 5000，超出截断并提示）",
                },
                "start_line": {
                    "type": "integer",
                    "description": "（可选）起始行号（从 1 开始）",
                },
                "end_line": {
                    "type": "integer",
                    "description": "（可选）结束行号",
                },
            },
            "required": [],
        }

    def execute(self, path: Optional[str] = None, filename: Optional[str] = None,
                max_chars: int = 5000, start_line=None, end_line=None, **kwargs) -> ToolResult:
        if not path and not filename:
            return ToolResult(success=False, output="", error="必须提供 path 或 filename 参数")
        params = {"max_chars": int(max_chars)}
        if path:
            params["path"] = path
        if filename:
            params["filename"] = filename
        if start_line is not None:
            params["start_line"] = int(start_line)
        if end_line is not None:
            params["end_line"] = int(end_line)
        result = _run_ui_action("nb_file_read", params, timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  8. nb_file_edit
# ---------------------------------------------------------------------------

class NbFileEditTool(BaseTool):
    name = "nb_file_edit"

    description = (
        "修改 JupyterLab 中打开的其他文件（.py/.md/.txt/.json 等文本文件）。"
        "三种修改方式："
        "1. 提供 content：整体替换文件内容；"
        "2. 提供 old_str + new_str：精确字符串替换（old_str 必须与文件内容完全一致）；"
        "3. 提供 selection_text + new_str：替换文件编辑器中选中的文本。"
        "修改后编辑器实时同步，但需要用户在编辑器中保存（Ctrl+S）才落盘。"
    )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径（绝对路径或相对 JupyterLab 工作目录的路径）",
                },
                "filename": {
                    "type": "string",
                    "description": "按文件名匹配当前打开的编辑器文件（不区分目录），与 path 二选一",
                },
                "content": {
                    "type": "string",
                    "description": "（可选）整体替换的文件新内容",
                },
                "old_str": {
                    "type": "string",
                    "description": "（可选）要替换的现有文本（精确匹配，必须唯一）",
                },
                "new_str": {
                    "type": "string",
                    "description": "（可选）替换后的文本（与 old_str 或 selection_text 配合）",
                },
                "selection_text": {
                    "type": "string",
                    "description": "（可选）要替换的编辑器选中文本（须与当前选中内容一致）",
                },
                "insert_at_line": {
                    "type": "integer",
                    "description": "（可选）在此行号（1-based）附近插入 new_str 作为新行（不替换现有内容）。"
                                   "用于在用户光标处添加代码",
                },
                "insert_at_col": {
                    "type": "integer",
                    "description": "（可选）配合 insert_at_line 的光标列号（1-based）：列=1 插到该行上方，"
                                   "列>1 插到该行下方。缺省按行首处理",
                },
            },
            "required": [],
        }

    def execute(self, path: Optional[str] = None, filename: Optional[str] = None,
                content: Optional[str] = None, old_str: Optional[str] = None,
                new_str: Optional[str] = None,
                selection_text: Optional[str] = None,
                insert_at_line: Optional[int] = None,
                insert_at_col: Optional[int] = None, **kwargs) -> ToolResult:
        if not path and not filename:
            return ToolResult(success=False, output="", error="必须提供 path 或 filename 参数")
        if content is None and old_str is None and selection_text is None and insert_at_line is None:
            return ToolResult(
                success=False, output="",
                error="必须提供 content（整体替换）、old_str（字符串替换）、selection_text（替换选中）"
                      "或 insert_at_line（插入新行）之一")
        if old_str is not None and not old_str:
            return ToolResult(success=False, output="", error="old_str 不能为空")
        if insert_at_line is not None and new_str is None:
            return ToolResult(success=False, output="", error="insert_at_line 需配合 new_str（要插入的内容）")
        params = {}
        if path:
            params["path"] = path
        if filename:
            params["filename"] = filename
        if content is not None:
            params["content"] = content
        if old_str is not None:
            params["old_str"] = old_str
        if new_str is not None:
            params["new_str"] = new_str
        if selection_text is not None:
            params["selection_text"] = selection_text
        if insert_at_line is not None:
            params["insert_at_line"] = int(insert_at_line)
            if insert_at_col is not None:
                params["insert_at_col"] = int(insert_at_col)
        result = _run_ui_action("nb_file_edit", params, timeout=QUICK_TIMEOUT)
        return _to_tool_result(result)


# ---------------------------------------------------------------------------
#  注册
# ---------------------------------------------------------------------------

NB_TOOLS: list = [
    NbGetSelectionTool(),
    NbListCellsTool(),
    NbEditCellTool(),
    NbInsertCellTool(),
    NbDeleteCellTool(),
    NbExecuteCellTool(),
    NbFileReadTool(),
    NbFileEditTool(),
]

# 供系统提示注入的工具描述（notebook 工具说明）
NOTEBOOK_TOOLS_DOC = (
    "## notebook 专用工具（JupyterLab 集成）\n"
    "当 JupyterLab 中打开 .ipynb 文件时，以下工具可用（由 cbhcli-jupyter 提供）：\n"
    "- nb_get_selection：获取当前选中的代码/代码块（含 cell 内高亮选区）\n"
    "- nb_list_cells：列出 notebook 全部 cell 概览\n"
    "- nb_edit_cell：修改指定 cell 的代码（支持替换选中片段）\n"
    "- nb_insert_cell：在指定位置插入新 cell\n"
    "- nb_delete_cell：删除指定 cell\n"
    "- nb_execute_cell：通过 notebook 内核执行代码并返回输出（共享变量空间）\n"
    "- nb_file_read / nb_file_edit：读取/修改 JupyterLab 中打开的其他文件\n"
    "操作 notebook 时优先使用 cell_index 定位（从 0 开始），"
    "不确定结构时先调用 nb_list_cells 或 nb_get_selection 查看。\n"
)


def register_notebook_tools(chat_session) -> bool:
    """把 notebook 工具注册到会话的工具注册表。

    幂等：已注册则跳过。返回是否执行了注册。
    """
    registry = getattr(chat_session, "tool_registry", None)
    if registry is None:
        return False
    added = False
    for tool in NB_TOOLS:
        if registry.get(tool.name) is None:
            try:
                registry.register(tool)
                added = True
            except Exception:
                pass
    if added:
        # 更新 tools schema token 数（与 WebChatSession._rebuild_tools 一致）
        try:
            import json as _json
            from cbhcli_pkg.context.token_counter import get_token_counter
            if chat_session.context_window and chat_session.token_counter:
                chat_session.context_window.tools_schema_tokens = (
                    chat_session.token_counter.count_tokens(
                        _json.dumps(registry.get_openai_tools(), ensure_ascii=False)))
        except Exception:
            pass
    return added

"""会话管理：复用 cbhcli_pkg.web.server 的 WebChatSession 与 ReAct 循环。

cbhcli Web 端（FastAPI）已经实现了完整的「统一会话封装」：
- WebChatSession：工具注册表/MCP/技能/系统提示/上下文压缩组件/Harness 组件
- _react_loop：完整 ReAct 循环（Function Calling + 自我反思 + 自动压缩 + 权限 + 死循环检测）
- _sse / _stream_round / _fill_aborted_tool_msgs / repair_tool_messages 等

本模块只做两件事：
1. 透传 cbhcli 的会话获取函数（保持同一会话缓存）；
2. 在会话创建后注入 notebook 工具（幂等）。
"""

from typing import Optional

from cbhcli_pkg.web.server import (
    WebChatSession,
    _get_or_create_session as _cbhcli_get_or_create_session,
    _chat_sessions,
    _get_session_key,
    get_agent_manager,
)

from .nb_tools import register_notebook_tools, NB_TOOLS

# 已注入 notebook 工具的会话 key 集合（registry 重建后由检查逻辑自动补充）
_injected_keys: set = set()


# ---------------------------------------------------------------------------
#  移除 Web 专有功能（send_file / 文件上传）—— cbhcli-jupyter 不需要
#  cbhcli 的 _rebuild_system_prompt 会在系统提示末尾注入 "## Web 界面功能"
#  （📎 上传文件 + send_file 发送文件），这些是 Web 端专有、jupyter 插件不具备。
#  这里给 _rebuild_system_prompt 打补丁：构建后裁掉该段，避免 AI 误用不存在的功能。
# ---------------------------------------------------------------------------
_WEB_NOTE_MARKER = "## Web 界面功能"
_orig_rebuild_system_prompt = WebChatSession._rebuild_system_prompt


def _rebuild_system_prompt_no_webnote(self):
    _orig_rebuild_system_prompt(self)
    try:
        msgs = self.session.messages
        if msgs and msgs[0].role == "system":
            content = msgs[0].content or ""
            idx = content.find(_WEB_NOTE_MARKER)
            if idx != -1:
                msgs[0].content = content[:idx].rstrip()
    except Exception:
        pass


WebChatSession._rebuild_system_prompt = _rebuild_system_prompt_no_webnote


def get_or_create_session(agent_name: str, model_name: str) -> WebChatSession:
    """获取或创建会话（复用 cbhcli 的会话缓存），并确保 notebook 工具已注册。

    注意：cbhcli 的 _rebuild_tools()（工具开关/MCP 变更时）会重建注册表，
    重建后 notebook 工具会丢失；这里每次获取时做一次轻量检查并补充。
    """
    cs = _cbhcli_get_or_create_session(agent_name, model_name)
    _ensure_notebook_tools(cs)
    return cs


def _ensure_notebook_tools(cs: WebChatSession) -> None:
    """幂等注入 notebook 工具到会话注册表，并移除 Web 专有的 send_file。"""
    try:
        registry = getattr(cs, "tool_registry", None)
        if registry is None:
            return
        if registry.get("nb_get_selection") is None:
            if register_notebook_tools(cs):
                _injected_keys.add(cs.session_key)
            # 只读类 notebook 工具免确认（与 cbhcli Web _READONLY_TOOLS 策略一致）
            _grant_readonly_permission(cs)
        # cbhcli-jupyter 不需要 send_file（Web 专有功能）；_rebuild_tools 重建后会重新注册，
        # 故每次获取会话都检查并注销
        if registry.get("send_file") is not None:
            registry.unregister("send_file")
    except Exception:
        pass


def set_nb_tools_enabled(cs: WebChatSession, enabled: bool) -> None:
    """按小眼睛状态启用/禁用全部 notebook 工具（严格模式）。

    小眼睛严格模式：nb 工具仅在「注入了选区上下文」时启用，其余情况一律禁用，
    使 agent 只做普通问答 + 非 nb 内置工具调用，杜绝其自主翻改 notebook。

    实现机制（利用 cbhcli ToolRegistry 的 _disabled_tools 集合）：
    - 禁用 = 把 nb 工具名加入 `_disabled_tools`：
      * `get_openai_tools()` 不再返回它们 → LLM 工具 schema 里看不到，无法发起调用；
      * `execute()` 对禁用工具直接返回错误 → 双保险（即便模型凭历史记忆硬调也会被拒）。
    - 启用 = 从 `_disabled_tools` 移除 nb 工具名。
    只增删 nb 工具，不影响 agent 配置里其他被禁用的工具。

    与工具弹窗的关系（v0.2.9）：用户可在「工具」弹窗单独勾选启停 nb 工具，
    该偏好持久化在 agent config 的 disabled_tools 中。小眼睛放开 nb 工具时
    不能把「用户手动禁用」的项也放开，故 enabled=True 时仅放开未被用户禁用的
    nb 工具。有效启用状态 = (小眼睛允许) AND (用户未禁用)。

    注意：`_react_loop` 在循环开始时一次性读取 `get_openai_tools()`，
    因此必须在进入 `_react_loop` 前调用本函数（见 handlers.ChatHandler）。
    """
    try:
        registry = getattr(cs, "tool_registry", None)
        if registry is None:
            return
        nb_names = {t.name for t in NB_TOOLS}
        current = set(getattr(registry, "_disabled_tools", set()) or set())
        if enabled:
            current -= nb_names                       # 小眼睛开：放开全部 nb
            current |= _user_disabled_nb_tools(cs)    # 但用户手动禁用的保持禁用
        else:
            current |= nb_names                       # 小眼睛关：禁用全部 nb
        registry.set_disabled_tools(sorted(current))
    except Exception:
        pass


def _user_disabled_nb_tools(cs: WebChatSession) -> set:
    """返回用户在工具弹窗中明确禁用的 nb 工具名集合（读 agent config，实时）。

    toggle_tool 保存配置后不一定回写 cs.agent_config，故这里直接从磁盘加载，
    避免拿到陈旧的禁用列表。
    """
    try:
        agent_name = getattr(cs, "agent_name", "") or ""
        if not agent_name:
            return set()
        config = get_agent_manager().load_agent(agent_name)
        if config and getattr(config, "disabled_tools", None):
            nb_names = {t.name for t in NB_TOOLS}
            return nb_names & set(config.disabled_tools)
    except Exception:
        pass
    return set()


def _grant_readonly_permission(cs: WebChatSession) -> None:
    """为只读类 notebook 工具添加 allow 权限规则（免确认）。

    只读工具：nb_get_selection / nb_list_cells / nb_file_read
    修改类工具（nb_edit_cell / nb_insert_cell / nb_delete_cell /
    nb_execute_cell / nb_file_edit）仍按权限模式确认。
    """
    try:
        from cbhcli_pkg.core.permissions import PermissionEngine
        engine = cs.permission_engine
        if engine is None:
            from cbhcli_pkg.web.server import get_permission_engine
            engine = get_permission_engine()
            cs.permission_engine = engine
        for tool_name in ("nb_get_selection", "nb_list_cells", "nb_file_read"):
            engine.add_rule("allow", f"{tool_name}(*)")
    except Exception:
        pass


def get_session(agent_name: str, model_name: str) -> Optional[WebChatSession]:
    """仅获取（不创建）会话。"""
    key = _get_session_key(agent_name, model_name)
    cs = _chat_sessions.get(key)
    if cs is not None:
        _ensure_notebook_tools(cs)
    return cs


def get_all_sessions() -> dict:
    """获取全部活动会话（内部使用）。"""
    return _chat_sessions


__all__ = [
    "WebChatSession",
    "get_or_create_session",
    "get_session",
    "get_all_sessions",
    "set_nb_tools_enabled",
]

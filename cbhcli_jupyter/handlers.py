"""tornado HTTP handlers：SSE 聊天 + 管理 API 代理 + notebook UI 任务桥。

管理类 API 直接复用 cbhcli_pkg.web.server 的端点函数（同步或异步均可），
保持与 cbhcli Web 完全一致的逻辑与数据结构。
"""

import asyncio
import inspect
import json
import logging
import os
from typing import Optional

import tornado.web
from fastapi import HTTPException

from cbhcli_pkg.web.server import (
    _sse,
    _react_loop,
    _get_session_key,
    _chat_sessions,
    _get_agent_config,
    get_config,
    get_agent_manager,
    # 管理端点函数（复用，保持与 cbhcli Web 一致）
    get_info,
    get_settings,
    update_settings,
    list_models,
    add_model,
    update_model,
    delete_model,
    select_model,
    update_embedding_model,
    delete_embedding_model,
    update_rerank_model,
    delete_rerank_model,
    get_fallback,
    add_fallback,
    clear_fallback,
    remove_fallback,
    reorder_fallback,
    get_permissions,
    set_permission_mode,
    update_permission_rule,
    get_hooks,
    reload_hooks,
    list_backups,
    undo_backup,
    list_agents,
    create_agent,
    get_agent,
    update_agent,
    delete_agent,
    select_agent,
    list_history,
    get_history,
    delete_history,
    list_tools,
    toggle_tool,
    list_skills,
    activate_skills,
    deactivate_skill,
    WebChatSession,
    # pydantic 请求模型
    ModelConfig,
    EmbeddingModelConfig,
    RerankModelConfig,
    AgentCreate,
    AgentUpdate,
    SettingsUpdate,
    FallbackAdd,
    FallbackReorder,
    ModeUpdate,
    PermissionRuleUpdate,
    UndoRequest,
    Toggle,
    SkillActivate,
    # MCP 管理（复用 cbhcli web 端点函数）
    list_mcp_servers,
    add_mcp_server,
    remove_mcp_server,
    refresh_mcp_server,
    list_mcp_server_tools,
    toggle_mcp_tool,
    MCPServerAdd,
    # Agent 链条（list 复用端点函数；use/off 需自定义 handler 操作会话）
    list_chains,
    _get_chain_manager,
    # 知识库管理（复用 cbhcli web 端点函数，v0.2.15）
    list_knowledge,
    add_knowledge_file,
    remove_knowledge_file,
    reindex_knowledge,
    embedding_status,
    embedding_index,
    KnowledgeAdd,
)
from cbhcli_pkg.core.session_history import SessionHistoryManager
from cbhcli_pkg.tools.python_tool import remove_python_session

from . import chat_api
from .nb_task_queue import task_queue

logger = logging.getLogger("cbhcli_jupyter")

# 路由前缀
PREFIX = "/cbhcli/api"


# ===================================================================
#  通用工具
# ===================================================================

def _parse_body(handler: tornado.web.RequestHandler) -> dict:
    """解析 JSON 请求体。"""
    if not handler.request.body:
        return {}
    try:
        return json.loads(handler.request.body)
    except Exception:
        raise tornado.web.HTTPError(400, "请求体不是合法 JSON")


def _send_json(handler: tornado.web.RequestHandler, data, status: int = 200):
    """JSON 响应。"""
    handler.set_status(status)
    handler.set_header("Content-Type", "application/json; charset=utf-8")
    if isinstance(data, (dict, list)):
        handler.finish(json.dumps(data, ensure_ascii=False, default=str))
    else:
        handler.finish(str(data))


def _handle_error(handler: tornado.web.RequestHandler, e: Exception):
    """统一异常转换（fastapi HTTPException → tornado）。

    v0.3.1 修复：错误响应必须带正确的 HTTP 状态码。旧版先 set_status(4xx/5xx)
    再调 _send_json()，而 _send_json 默认参数会把状态码重置回 200 →
    所有 API 错误（如模型编辑字段校验失败）都以 200 返回，前端 response.ok=true
    把 {"error": ...} 当成功处理，用户看不到任何报错（"编辑不生效"的帮凶）。
    """
    if isinstance(e, HTTPException):
        _send_json(handler, {"error": getattr(e, "detail", str(e))},
                   status=e.status_code or 400)
    elif isinstance(e, tornado.web.HTTPError):
        _send_json(handler, {"error": e.reason or str(e)}, status=e.status_code)
    else:
        logger.exception("cbhcli_jupyter API 错误")
        _send_json(handler, {"error": f"{type(e).__name__}: {e}"}, status=500)


def spec(fn, *, model_cls=None, body_arg="body", path_args=()):
    """单个端点规格（供 api_handler 使用）。"""
    return {"fn": fn, "model_cls": model_cls, "body_arg": body_arg, "path_args": path_args}


def api_handler(methods):
    """工厂：按 HTTP 方法分发到 cbhcli web 端点函数。

    methods: dict，键为小写方法名（get/post/put/delete），值为 spec() 返回的规格。

    ⚠️ tornado 同一 URL 只会有一个 handler 生效（按注册顺序取第一个，不按方法分发），
    因此同一 URL 的多个方法必须合并进同一个 handler 内按方法分发。
    （v0.2.15 修复：旧版对同 URL 注册多个 api_handler，导致 POST/PUT/DELETE 全部
    打到第一个 GET handler 上，添加模型/MCP/知识库等写操作全部失败。）
    """
    class _ApiHandler(tornado.web.RequestHandler):
        async def _run(self, method):
            sp = methods.get(method)
            if sp is None:
                raise tornado.web.HTTPError(405, "方法不允许")
            fn = sp["fn"]
            model_cls = sp.get("model_cls")
            body_arg = sp.get("body_arg", "body")
            path_args = sp.get("path_args", ())
            try:
                kwargs = {}
                for name in path_args:
                    kwargs[name] = self.path_kwargs.get(name)
                body = _parse_body(self)
                if model_cls is not None:
                    kwargs[body_arg] = model_cls(**body)
                elif body:
                    kwargs[body_arg] = body
                # 同步端点放到线程执行，避免阻塞 tornado 事件循环
                # （如 MCP 连接/刷新等网络操作，未达服务器会阻塞数十秒，v0.2.15）
                if inspect.iscoroutinefunction(fn):
                    result = await fn(**kwargs)
                else:
                    result = await asyncio.to_thread(fn, **kwargs)
                if inspect.isawaitable(result):
                    result = await result
                _send_json(self, result if result is not None else {"message": "ok"})
            except Exception as e:
                _handle_error(self, e)

        async def get(self, *args, **kwargs):
            await self._run("get")

        async def post(self, *args, **kwargs):
            await self._run("post")

        async def put(self, *args, **kwargs):
            await self._run("put")

        async def delete(self, *args, **kwargs):
            await self._run("delete")

    return _ApiHandler


# ===================================================================
#  信息 / 状态
# ===================================================================

class InfoHandler(tornado.web.RequestHandler):
    """插件信息（前端初始化时调用）。"""

    def get(self):
        _send_json(self, {
            "status": "ok",
            "name": "cbhcli_jupyter",
            "version": "0.3.2",
            "cbhcli_version": getattr(chat_api, "_cbhcli_version", None)
            or _safe_cbhcli_version(),
            "api": "v1",
        })


def _safe_cbhcli_version() -> Optional[str]:
    try:
        import cbhcli_pkg
        return getattr(cbhcli_pkg, "__version__", "unknown")
    except Exception:
        return "unknown"


def _get_server_root(handler: tornado.web.RequestHandler) -> str:
    """Jupyter 服务器根目录（绝对路径）。"""
    root = ""
    try:
        ext_app = handler.settings.get("cbhcli_jupyter_app")
        serverapp = getattr(ext_app, "serverapp", None)
        if serverapp is not None:
            root = getattr(serverapp, "root_dir", "") or ""
    except Exception:
        root = ""
    return root or os.getcwd()


def _resolve_cwd(handler: tornado.web.RequestHandler, path: str) -> str:
    """把文件浏览器相对路径解析为绝对路径（相对服务器根目录）。"""
    path = (path or "").strip()
    if not path:
        return _get_server_root(handler)
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(_get_server_root(handler), path))


class ServerRootHandler(tornado.web.RequestHandler):
    """返回 Jupyter 服务器根目录（绝对路径），供前端拼接文件浏览器路径。"""

    def get(self):
        _send_json(self, {"root": _get_server_root(self), "cwd": os.getcwd()})


class SetCwdHandler(tornado.web.RequestHandler):
    """切换 Agent 工作目录（跟随文件浏览器）。

    cbhcli 的 terminal/read/write 等工具都基于进程 os.getcwd()，
    这里把服务器进程 cwd 切到文件浏览器当前目录，使工具实时在该目录工作。
    """

    async def post(self):
        body = _parse_body(self)
        path = body.get("path", "")
        target = _resolve_cwd(self, path)
        if not os.path.isdir(target):
            _send_json(self, {"ok": False, "cwd": os.getcwd(),
                              "message": f"目录不存在: {target}"})
            return
        try:
            os.chdir(target)
            _send_json(self, {"ok": True, "cwd": os.getcwd()})
        except Exception as e:
            _send_json(self, {"ok": False, "cwd": os.getcwd(),
                              "message": f"切换失败: {e}"})


class ChatStatusHandler(tornado.web.RequestHandler):
    """会话状态（对齐 cbhcli web /api/chat/status）。"""

    def get(self):
        agent_name = self.get_query_argument("agent_name", "main")
        model_name = self.get_query_argument("model_name", "")
        cs = chat_api.get_session(agent_name, model_name)
        if not cs:
            # 无会话时从模型配置取 context_limit 作为分母（前端上下文条显示）
            model_limit = 0
            try:
                cfg = get_config()
                m = cfg.get_model(model_name) if model_name else None
                if m:
                    model_limit = int(m.get("context_limit") or 0)
            except Exception:
                model_limit = 0
            result = {
                "active": False, "message_count": 0, "token_estimate": 0,
                "ctx_percentage": 0.0, "model_limit": model_limit,
                "remaining_tokens": model_limit,
                "tool_call_count": 0, "active_chain": None,
                "cwd": os.getcwd(),
            }
            _send_json(self, result)
            return
        try:
            stats = cs.usage_stats()
        except Exception:
            stats = {}
        stats.update({"active": True, "busy": bool(cs.lock and cs.lock.locked()),
                      "cwd": os.getcwd()})
        stats["active_chain"] = cs.active_chain.name if cs.active_chain else None
        _send_json(self, stats)


class ChatMessagesHandler(tornado.web.RequestHandler):
    """导出会话消息（前端刷新恢复）。"""

    def get(self):
        agent_name = self.get_query_argument("agent_name", "main")
        model_name = self.get_query_argument("model_name", "")
        cs = chat_api.get_session(agent_name, model_name)
        _send_json(self, {"messages": cs.export_messages() if cs else []})


# ===================================================================
#  SSE 聊天
# ===================================================================

class ChatHandler(tornado.web.RequestHandler):
    """SSE 流式聊天端点（完整 ReAct 工具执行循环，与 cbhcli web 一致）。"""

    def _set_stream_session(self, cs) -> None:
        """记录当前 SSE 流绑定的会话（on_connection_close 用）。"""
        self._cs = cs

    def on_connection_close(self):
        """客户端断开 SSE 连接（页面关闭/刷新/强断兜底）时请求中断。

        v0.3.2：对齐 cbhcli Web（FastAPI 断流即取消生成器）。tornado 不会自动
        取消 handler 协程，若不置 abort，后端会在无人消费的情况下把整轮
        ReAct 循环跑完（工具照常执行），白白消耗 API 与算力。
        """
        cs = getattr(self, "_cs", None)
        if cs is not None:
            cs.abort = True

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")
        message = body.get("message", "")
        if not model_name:
            raise tornado.web.HTTPError(400, "缺少 model_name")
        if not message:
            raise tornado.web.HTTPError(400, "缺少 message")

        # 工作目录跟随文件浏览器（前端随消息带上当前路径）
        req_cwd = body.get("cwd", "")
        if req_cwd:
            target = _resolve_cwd(self, req_cwd)
            if os.path.isdir(target):
                try:
                    os.chdir(target)
                except Exception:
                    pass

        try:
            cs = chat_api.get_or_create_session(agent_name, model_name)
        except HTTPException as e:
            raise tornado.web.HTTPError(e.status_code or 400, getattr(e, "detail", str(e)))
        self._set_stream_session(cs)

        if cs.lock.locked():
            # v0.3.1：中断（abort）后上一请求可能仍在收尾——工具执行不可被立即打断，
            # _react_loop 要到下一个检查点才退出释放锁。此时立即 409 会让用户
            # "中断后再发消息"报 conflict。改为短暂等待锁释放（最多 30 秒），
            # 仍不释放才报 409。
            for _ in range(60):
                await asyncio.sleep(0.5)
                if not cs.lock.locked():
                    break
            if cs.lock.locked():
                raise tornado.web.HTTPError(409, "该会话正在处理中，请等待完成或先中断")

        # 小眼睛严格模式：前端随消息带上 nb_enabled（= 是否注入了选区上下文）。
        # 仅当注入了选区上下文时启用 nb 工具，否则禁用 → agent 只做普通问答+非 nb 工具。
        # 必须在 _react_loop 前设置（循环开始时一次性读取工具 schema）。
        # 缺省 True 以兼容未携带该字段的旧客户端。
        chat_api.set_nb_tools_enabled(cs, bool(body.get("nb_enabled", True)))

        # UserPromptSubmit 钩子（与 cbhcli web 一致）
        user_message = message
        if cs.hook_manager and cs.hook_manager.has_hooks("UserPromptSubmit"):
            try:
                decision = await asyncio.to_thread(
                    cs.hook_manager.run_simple, "UserPromptSubmit",
                    session_id=cs.session.id,
                    extra_args={"prompt": message})
                extra = decision.merged_output()
                if extra:
                    user_message = f"{user_message}\n\n[钩子补充上下文]\n{extra}"
            except Exception:
                pass

        cs.session.add_message("user", user_message,
                               images=body.get("images") or None)
        cs.abort = False

        # SSE 响应头
        self.set_header("Content-Type", "text/event-stream; charset=utf-8")
        self.set_header("Cache-Control", "no-cache")
        self.set_header("Connection", "keep-alive")
        self.set_header("X-Accel-Buffering", "no")

        async with cs.lock:
            try:
                # SessionStart 钩子输出（会话创建时收集，首次聊天下发）
                if cs.hook_start_outputs:
                    for line in cs.hook_start_outputs:
                        self.write(_sse({"type": "hook_output",
                                         "event": "SessionStart", "content": line}))
                        await self.flush()
                    cs.hook_start_outputs = []

                async for ev in _react_loop(cs):
                    self.write(ev)
                    await self.flush()

                # Stop 钩子
                if cs.hook_manager and cs.hook_manager.has_hooks("Stop"):
                    try:
                        decision = await asyncio.to_thread(
                            cs.hook_manager.run_simple, "Stop",
                            session_id=cs.session.id)
                        for line in decision.outputs:
                            self.write(_sse({"type": "hook_output",
                                             "event": "Stop", "content": line}))
                            await self.flush()
                    except Exception:
                        pass
            except Exception as e:
                logger.exception("聊天 SSE 处理异常")
                self.write(_sse({"type": "error", "content": str(e)}))
                try:
                    self.write(_sse({"type": "done", "usage": cs.usage_stats()}))
                except Exception:
                    pass
                await self.flush()
        self.finish()


class ChatRespondHandler(tornado.web.RequestHandler):
    """工具确认 / ask_user 应答。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")
        response = body.get("response", "")
        cs = chat_api.get_session(agent_name, model_name)
        if cs and cs.respond_queue is not None:
            await cs.respond_queue.put(response)
            _send_json(self, {"message": "应答已接收"})
        else:
            _send_json(self, {"message": "无待处理操作"})


class ChatAbortHandler(tornado.web.RequestHandler):
    """中断当前流式响应。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")
        cs = chat_api.get_session(agent_name, model_name)
        if cs:
            cs.abort = True
        # v0.3.2：立即取消所有未完成的 notebook UI 任务。
        # notebook 工具线程阻塞在 task.wait() 等前端回传（最长 300s），
        # 不取消的话 ReAct 循环要等当前工具结束才能在中断检查点退出，
        # 表现为"停止不停任务"（notebook cell 一路跑完）。
        try:
            task_queue.cancel_all("用户已中断")
        except Exception:
            pass
        _send_json(self, {"message": "已请求中断"})


class ChatResetHandler(tornado.web.RequestHandler):
    """新建会话（自动保存当前会话到历史，与 cbhcli web 一致）。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")
        key = _get_session_key(agent_name, model_name)
        cs = _chat_sessions.pop(key, None)
        if cs:
            cs.abort = True
            if cs.session and len(cs.session.messages) > 1:
                agent_config = _get_agent_config(agent_name)
                if agent_config:
                    try:
                        SessionHistoryManager(agent_config.workspace_path).save_session(
                            cs.session.get_context_messages(), cs.session.id)
                    except Exception:
                        pass
        try:
            remove_python_session("default")
        except Exception:
            pass
        _send_json(self, {"message": "会话已重置"})


class ChatSwitchModelHandler(tornado.web.RequestHandler):
    """原地切换模型，保留当前会话全部内容（对齐 cbhcli web）。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        old_model = body.get("old_model", "")
        new_model = body.get("new_model", "")
        if not agent_name or not new_model:
            raise tornado.web.HTTPError(400, "缺少 agent_name / new_model")

        config = get_config()
        model_config = config.get_model(new_model)
        if not model_config:
            raise tornado.web.HTTPError(404, f"模型 '{new_model}' 不存在")
        config.set_last_selected_model(new_model)

        old_key = _get_session_key(agent_name, old_model or new_model)
        new_key = _get_session_key(agent_name, new_model)
        cs = _chat_sessions.get(old_key)
        if cs is None or old_key == new_key:
            _send_json(self, {"switched": False,
                              "message": f"已选择模型 '{new_model}'"})
            return

        # 新键位若已有旧会话：保存到历史后让位
        existing = _chat_sessions.pop(new_key, None)
        if existing is not None and existing is not cs:
            existing.abort = True
            if existing.session and len(existing.session.messages) > 1:
                try:
                    agent_config = _get_agent_config(agent_name)
                    if agent_config:
                        SessionHistoryManager(agent_config.workspace_path).save_session(
                            existing.session.get_context_messages(), existing.session.id)
                except Exception:
                    pass

        # 原地替换模型组件
        from cbhcli_pkg.core.model import LLMClient
        from cbhcli_pkg.context.token_counter import get_token_counter
        from cbhcli_pkg.context.compressor import ContextCompressor

        cs.llm_client = LLMClient(model_config)
        cs.token_counter = get_token_counter(model_config.get("model"))
        cs.context_compressor = ContextCompressor(
            cs.llm_client, cs.token_counter,
            workspace_path=getattr(cs.agent_config, "workspace_path", None))
        if cs.context_window:
            cs.context_window.model_limit = cs.llm_client.context_limit
        if cs.app_proxy:
            cs.app_proxy.llm_client = cs.llm_client
            cs.app_proxy.token_counter = cs.token_counter
            cs.app_proxy.context_compressor = cs.context_compressor
        cs.model_name = new_model
        cs.session_key = new_key
        cs._rebuild_system_prompt()

        _chat_sessions.pop(old_key, None)
        _chat_sessions[new_key] = cs
        chat_api._ensure_notebook_tools(cs)

        _send_json(self, {
            "switched": True,
            "message": f"已切换到模型 '{new_model}'（会话及上下文已保留）",
            "usage": cs.usage_stats(),
        })


class ChatLoadHandler(tornado.web.RequestHandler):
    """加载历史会话为当前会话（完整重建压缩组件，与 cbhcli web 一致）。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")
        filename = body.get("filename", "")
        if not agent_name or not model_name or not filename:
            raise tornado.web.HTTPError(400, "缺少 agent_name / model_name / filename")
        agent_config = _get_agent_config(agent_name)
        if not agent_config:
            raise tornado.web.HTTPError(404, f"Agent '{agent_name}' 不存在")
        history_mgr = SessionHistoryManager(agent_config.workspace_path)
        hist_messages = history_mgr.load_session(filename)
        if hist_messages is None:
            raise tornado.web.HTTPError(404, "会话不存在")
        # 先保存并移除旧会话
        key = _get_session_key(agent_name, model_name)
        old = _chat_sessions.pop(key, None)
        if old and old.session and len(old.session.messages) > 1:
            try:
                history_mgr.save_session(
                    old.session.get_context_messages(), old.session.id)
            except Exception:
                pass
        # 全新会话（含全部组件），再注入历史消息
        # v0.3.0：跳过 system 消息（保留新建系统提示），但保留上下文压缩生成的
        # "历史对话摘要"——摘要是 agent 对早期对话的记忆，丢弃它会导致恢复
        # 压缩过的会话后 agent 失忆（对齐 cbhcli v5.2.3 chat_load 修复）
        from cbhcli_pkg.context.compressor import SUMMARY_MARKER
        cs = WebChatSession.create(agent_name, model_name)
        for msg in hist_messages:
            role = msg.get("role", "")
            content = msg.get("content", "") or ""
            if role == "system" and not content.startswith(SUMMARY_MARKER):
                continue
            cs.session.add_message(
                role, content,
                tool_call_id=msg.get("tool_call_id"),
                tool_calls=msg.get("tool_calls"),
                reasoning_content=msg.get("reasoning_content"),
            )
        _chat_sessions[key] = cs
        chat_api._ensure_notebook_tools(cs)
        _send_json(self, {
            "message": "会话已加载",
            "messages": cs.export_messages(),
            "usage": cs.usage_stats(),
        })


class ChatCompressHandler(tornado.web.RequestHandler):
    """手动压缩上下文。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")
        # v0.3.0：兼容 instructions（复数，cbhcli web 约定）与 instruction（单数，旧字段）
        instruction = body.get("instructions") or body.get("instruction") or ""
        cs = chat_api.get_session(agent_name, model_name)
        if not cs or not cs.context_compressor or not cs.context_window:
            raise tornado.web.HTTPError(404, "会话不存在或压缩组件未初始化")
        try:
            ok = await asyncio.to_thread(
                cs.context_compressor.compress,
                cs.session,
                cs.context_window.compression_target(),
                instructions=instruction or None,
            )
        except Exception as e:
            _send_json(self, {"success": False, "message": f"压缩失败: {e}"})
            return
        if ok:
            new_tokens = cs.session.get_total_tokens(cs.token_counter)
            cs.context_window.update(new_tokens)
            _send_json(self, {
                "success": True,
                "message": f"上下文已压缩 ({cs.context_window.get_status_text()})",
                "usage": cs.usage_stats(),
            })
        else:
            _send_json(self, {"success": False, "message": "压缩失败"})


# ===================================================================
#  Agent 链条：激活 / 取消（操作会话，复用 cbhcli web 逻辑）
#  说明：create/update/delete 链条的多层编排仍走 CLI /chain 或 web；
#        本插件只做「实用级」——列出链条 + 为当前会话激活/取消。
# ===================================================================

class ChainUseHandler(tornado.web.RequestHandler):
    """当前会话绑定链条（对齐 cbhcli web /api/chat/use-chain）。"""

    async def post(self):
        body = _parse_body(self)
        chain_name = body.get("chain_name", "")
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")

        cm = _get_chain_manager()
        chain = cm.get_chain(chain_name)
        if not chain:
            raise tornado.web.HTTPError(404, f"链条 '{chain_name}' 不存在")
        missing = chain.validate(get_agent_manager())
        if missing:
            raise tornado.web.HTTPError(
                400, f"链条中引用了不存在的 Agent: {', '.join(missing)}")
        root = chain.get_root_agent()
        if agent_name != root:
            raise tornado.web.HTTPError(
                400, f"链条 '{chain_name}' 的元 Agent 是 '{root}'，"
                     f"当前 Agent 是 '{agent_name}'。请先切换到元 Agent 再激活。")

        cs = chat_api.get_or_create_session(agent_name, model_name)
        cs.active_chain = chain
        cs.chain_active_path = [chain.get_root_agent()]
        cs.app_proxy.active_chain = chain
        cs.app_proxy.chain_active_path = cs.chain_active_path
        get_config().set_active_chain(root, chain_name)

        cs._rebuild_tools()           # 注册 call_agent
        cs._rebuild_system_prompt()   # 注入链条信息
        chat_api._ensure_notebook_tools(cs)  # rebuild 会丢 nb 工具，补回

        _send_json(self, {
            "message": f"链条 '{chain_name}' 已激活",
            "chain_name": chain_name,
            "root_agent": root,
        })


class ChainOffHandler(tornado.web.RequestHandler):
    """取消当前会话的链条绑定（对齐 cbhcli web /api/chat/off-chain）。"""

    async def post(self):
        body = _parse_body(self)
        agent_name = body.get("agent_name", "") or "main"
        model_name = body.get("model_name", "")

        cs = chat_api.get_or_create_session(agent_name, model_name)
        cs.active_chain = None
        cs.chain_active_path = None
        cs.app_proxy.active_chain = None
        cs.app_proxy.chain_active_path = None
        get_config().set_active_chain(agent_name, None)

        cs._rebuild_tools()
        cs._rebuild_system_prompt()
        chat_api._ensure_notebook_tools(cs)

        _send_json(self, {"message": "链条绑定已取消"})


# ===================================================================
#  notebook UI 任务桥
# ===================================================================

class NotebookPendingHandler(tornado.web.RequestHandler):
    """前端轮询获取待执行的 UI 任务（notebook 工具通道）。"""

    def get(self):
        tasks = task_queue.pending()
        _send_json(self, {"tasks": tasks})


class NotebookResultHandler(tornado.web.RequestHandler):
    """前端回传 UI 任务执行结果。"""

    async def post(self):
        body = _parse_body(self)
        task_id = body.get("task_id", "")
        result = body.get("result") or {}
        if not task_id:
            raise tornado.web.HTTPError(400, "缺少 task_id")
        ok = task_queue.complete(task_id, result)
        _send_json(self, {"ok": ok})


class NotebookActiveHandler(tornado.web.RequestHandler):
    """前端上报当前 notebook 状态（用于日志/调试，可选）。"""

    async def post(self):
        body = _parse_body(self)
        _send_json(self, {"ok": True})


class AgentToolsHandler(tornado.web.RequestHandler):
    """工具列表（内置工具 + notebook 工具）。

    cbhcli 的 list_tools 只返回 BUILTIN_TOOLS；这里追加 cbhcli-jupyter 的
    notebook 工具（category="Notebook 工具"），让用户能在「工具」弹窗里勾选启停。
    启停偏好与内置工具一致，持久化在 agent config 的 disabled_tools（toggle_tool 通用）。
    小眼睛严格模式仍会在每次请求时整体放开/收起 nb 工具，但不会放开用户手动禁用的项
    （见 chat_api.set_nb_tools_enabled）。
    """

    def get(self, agent_name):
        try:
            data = list_tools(agent_name)  # cbhcli web 端点函数（返回 dict）
            tools = list(data.get("tools", []))
            disabled = set(data.get("disabled", []))
            from .nb_tools import NB_TOOLS
            for t in NB_TOOLS:
                tools.append({
                    "name": t.name,
                    "description": t.description,
                    "category": "Notebook 工具",
                    "enabled": t.name not in disabled,
                })
            data["tools"] = tools
            _send_json(self, data)
        except Exception as e:
            _handle_error(self, e)


# ===================================================================
#  模型编辑（v0.3.1：编辑成功后同步刷新正在使用该模型的活动会话）
# ===================================================================

async def update_model_and_refresh(model_name: str, model) -> dict:
    """更新模型配置，并刷新正在使用该模型的活动会话组件。

    cbhcli 的 update_model 只写 config.json；活动会话（WebChatSession）的
    llm_client/token_counter/context_compressor/context_window 是创建时构建的缓存，
    不会自动感知配置变化 → 用户编辑当前使用的模型（改 context_limit/温度/密钥等）
    后"不生效"。这里在编辑成功后对使用该模型的每个会话原地重建这些组件
    （逻辑对齐 ChatSwitchModelHandler 的原地切换，但保留会话消息与模型名）。
    """
    # 同步端点放线程执行（含 config 读写），与 api_handler 一致
    result = await asyncio.to_thread(update_model, model_name, model)
    try:
        config = get_config()
        model_config = config.get_model(model_name)
        if not model_config:
            return result
        from cbhcli_pkg.core.model import LLMClient
        from cbhcli_pkg.context.token_counter import get_token_counter
        from cbhcli_pkg.context.compressor import ContextCompressor
        for cs in list(_chat_sessions.values()):
            if getattr(cs, "model_name", None) != model_name:
                continue
            cs.llm_client = LLMClient(model_config)
            cs.token_counter = get_token_counter(model_config.get("model"))
            cs.context_compressor = ContextCompressor(
                cs.llm_client, cs.token_counter,
                workspace_path=getattr(cs.agent_config, "workspace_path", None))
            if cs.context_window:
                cs.context_window.model_limit = cs.llm_client.context_limit
            if cs.app_proxy:
                cs.app_proxy.llm_client = cs.llm_client
                cs.app_proxy.token_counter = cs.token_counter
                cs.app_proxy.context_compressor = cs.context_compressor
    except Exception:
        logger.exception("模型编辑后刷新活动会话失败（配置已保存）")
    return result


# ===================================================================
#  路由表
# ===================================================================

handlers = [
    # --- 信息 ---
    (rf"{PREFIX}/info", InfoHandler),
    (rf"{PREFIX}/server_root", ServerRootHandler),
    (rf"{PREFIX}/set_cwd", SetCwdHandler),

    # --- 聊天（SSE / 控制） ---
    (rf"{PREFIX}/chat", ChatHandler),
    (rf"{PREFIX}/chat/respond", ChatRespondHandler),
    (rf"{PREFIX}/chat/abort", ChatAbortHandler),
    (rf"{PREFIX}/chat/reset", ChatResetHandler),
    (rf"{PREFIX}/chat/switch_model", ChatSwitchModelHandler),
    (rf"{PREFIX}/chat/compress", ChatCompressHandler),
    (rf"{PREFIX}/chat/status", ChatStatusHandler),
    (rf"{PREFIX}/chat/messages", ChatMessagesHandler),

    # --- notebook UI 任务桥 ---
    (rf"{PREFIX}/notebook/pending", NotebookPendingHandler),
    (rf"{PREFIX}/notebook/result", NotebookResultHandler),
    (rf"{PREFIX}/notebook/active", NotebookActiveHandler),

    # --- 配置 ---
    (rf"{PREFIX}/config", api_handler({
        "get": spec(get_settings),
        "put": spec(update_settings, model_cls=SettingsUpdate, body_arg="update"),
    })),

    # --- 模型管理 ---
    (rf"{PREFIX}/models", api_handler({
        "get": spec(list_models),
        "post": spec(add_model, model_cls=ModelConfig, body_arg="model"),
    })),
    (rf"{PREFIX}/models/embedding", api_handler({
        "put": spec(update_embedding_model, model_cls=EmbeddingModelConfig, body_arg="model"),
        "delete": spec(delete_embedding_model),
    })),
    (rf"{PREFIX}/models/rerank", api_handler({
        "put": spec(update_rerank_model, model_cls=RerankModelConfig, body_arg="model"),
        "delete": spec(delete_rerank_model),
    })),
    (rf"{PREFIX}/models/(?P<model_name>[^/]+)", api_handler({
        # v0.3.1：编辑成功后刷新正在使用该模型的活动会话（修复编辑不生效）
        "put": spec(update_model_and_refresh, model_cls=ModelConfig, body_arg="model", path_args=("model_name",)),
        "delete": spec(delete_model, path_args=("model_name",)),
    })),

    # --- 备用模型 ---
    (rf"{PREFIX}/fallback", api_handler({
        "get": spec(get_fallback),
        "post": spec(add_fallback, model_cls=FallbackAdd, body_arg="body"),
    })),
    (rf"{PREFIX}/fallback/clear/(?P<category>[^/]+)", api_handler({"delete": spec(clear_fallback, path_args=("category",))})),
    (rf"{PREFIX}/fallback/reorder/(?P<category>[^/]+)", api_handler({"put": spec(reorder_fallback, model_cls=FallbackReorder, body_arg="body", path_args=("category",))})),
    (rf"{PREFIX}/fallback/(?P<category>[^/]+)/(?P<model_name>[^/]+)", api_handler({"delete": spec(remove_fallback, path_args=("category", "model_name"))})),

    # --- 权限 / 钩子 / 撤销 ---
    (rf"{PREFIX}/permissions", api_handler({"get": spec(get_permissions)})),
    (rf"{PREFIX}/permissions/mode", api_handler({"post": spec(set_permission_mode, model_cls=ModeUpdate, body_arg="body")})),
    (rf"{PREFIX}/permissions/rule", api_handler({"post": spec(update_permission_rule, model_cls=PermissionRuleUpdate, body_arg="body")})),
    (rf"{PREFIX}/hooks/(?P<agent_name>[^/]+)", api_handler({"get": spec(get_hooks, path_args=("agent_name",))})),
    (rf"{PREFIX}/hooks/reload/(?P<agent_name>[^/]+)", api_handler({"post": spec(reload_hooks, path_args=("agent_name",))})),
    (rf"{PREFIX}/backups/(?P<agent_name>[^/]+)", api_handler({"get": spec(list_backups, path_args=("agent_name",))})),
    (rf"{PREFIX}/undo/(?P<agent_name>[^/]+)", api_handler({"post": spec(undo_backup, model_cls=UndoRequest, body_arg="body", path_args=("agent_name",))})),

    # --- Agent 管理 ---
    (rf"{PREFIX}/agents", api_handler({
        "get": spec(list_agents),
        "post": spec(create_agent, model_cls=AgentCreate, body_arg="agent"),
    })),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)", api_handler({
        "get": spec(get_agent, path_args=("agent_name",)),
        "put": spec(update_agent, model_cls=AgentUpdate, body_arg="update", path_args=("agent_name",)),
        "delete": spec(delete_agent, path_args=("agent_name",)),
    })),
    # v0.3.1：持久化所选 Agent（写 active_agent，插件启动时恢复，对齐 CLI/Web）
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/select", api_handler({"post": spec(select_agent, path_args=("agent_name",))})),

    # --- 历史会话 ---
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/history", api_handler({"get": spec(list_history, path_args=("agent_name",))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/history/(?P<filename>[^/]+)", api_handler({
        "get": spec(get_history, path_args=("agent_name", "filename")),
        "delete": spec(delete_history, path_args=("agent_name", "filename")),
    })),
    (rf"{PREFIX}/chat/load", ChatLoadHandler),

    # --- 工具管理（勾选启用/禁用） ---
    # GET 用自定义 handler：内置工具 + notebook 工具（category="Notebook 工具"）
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/tools", AgentToolsHandler),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/tools/(?P<tool_name>[^/]+)", api_handler({"put": spec(toggle_tool, model_cls=Toggle, body_arg="body", path_args=("agent_name", "tool_name"))})),

    # --- 技能管理（勾选激活/停用） ---
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/skills", api_handler({"get": spec(list_skills, path_args=("agent_name",))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/skills/activate", api_handler({"post": spec(activate_skills, model_cls=SkillActivate, body_arg="body", path_args=("agent_name",))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/skills/(?P<skill_name>[^/]+)/deactivate", api_handler({"post": spec(deactivate_skill, path_args=("agent_name", "skill_name"))})),

    # --- MCP 管理（服务器增删刷新 + 工具开关） ---
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/mcp", api_handler({
        "get": spec(list_mcp_servers, path_args=("agent_name",)),
        "post": spec(add_mcp_server, model_cls=MCPServerAdd, body_arg="body", path_args=("agent_name",)),
    })),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/mcp/(?P<server_name>[^/]+)/refresh", api_handler({"post": spec(refresh_mcp_server, path_args=("agent_name", "server_name"))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/mcp/(?P<server_name>[^/]+)/tools", api_handler({"get": spec(list_mcp_server_tools, path_args=("agent_name", "server_name"))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/mcp/(?P<server_name>[^/]+)/tools/(?P<tool_name>[^/]+)", api_handler({"put": spec(toggle_mcp_tool, model_cls=Toggle, body_arg="body", path_args=("agent_name", "server_name", "tool_name"))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/mcp/(?P<server_name>[^/]+)", api_handler({"delete": spec(remove_mcp_server, path_args=("agent_name", "server_name"))})),

    # --- 知识库管理（列表/添加/删除/重建索引 + 向量状态，v0.2.15） ---
    # 注意：/knowledge/reindex 必须在 /knowledge/{file_name} 之前注册（否则被后者截获）
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/knowledge", api_handler({
        "get": spec(list_knowledge, path_args=("agent_name",)),
        "post": spec(add_knowledge_file, model_cls=KnowledgeAdd, body_arg="body", path_args=("agent_name",)),
    })),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/knowledge/reindex", api_handler({"post": spec(reindex_knowledge, path_args=("agent_name",))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/knowledge/(?P<file_name>[^/]+)", api_handler({"delete": spec(remove_knowledge_file, path_args=("agent_name", "file_name"))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/embedding/status", api_handler({"get": spec(embedding_status, path_args=("agent_name",))})),
    (rf"{PREFIX}/agents/(?P<agent_name>[^/]+)/embedding/index", api_handler({"post": spec(embedding_index, path_args=("agent_name",))})),

    # --- Agent 链条（列出 + 为当前会话激活/取消） ---
    (rf"{PREFIX}/chains", api_handler({"get": spec(list_chains)})),
    (rf"{PREFIX}/chat/use-chain", ChainUseHandler),
    (rf"{PREFIX}/chat/off-chain", ChainOffHandler),
]

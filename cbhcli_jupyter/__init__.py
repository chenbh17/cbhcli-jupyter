"""cbhcli_jupyter - 基于 cbhcli 的 JupyterLab AI 助手插件（后端 server extension）。

架构说明：
- 后端完全复用 cbhcli_pkg.web.server 的会话与 ReAct 循环逻辑（WebChatSession / _react_loop）；
- 通过 jupyter_server ExtensionApp 注册 tornado handlers，提供 REST + SSE API；
- notebook 工具通过「UI 任务队列」桥接到前端执行（见 nb_task_queue.py / nb_tools.py）。
"""

import json
from jupyter_server.extension.application import ExtensionApp

from .handlers import handlers

# v0.3.3：chat_api 依赖 cbhcli_pkg--未安装（或版本过旧）时导入失败。
# 此时 handlers.py 已进入诊断模式（占位 chat_api + 所有 API 返回安装指引），
# 扩展本身必须继续加载，否则前端 UI 正常显示但所有 API 404 且无任何提示
# （Windows "可以显示但模型/Agent 识别不到"的根因）。
try:
    from . import chat_api  # noqa: F401  确保会话管理模块被加载
except Exception:  # pragma: no cover - 仅 cbhcli_pkg 缺失时触发
    chat_api = None  # type: ignore[assignment]


class CbhcliJupyterApp(ExtensionApp):
    """cbhcli_jupyter 的 jupyter_server 扩展入口。"""

    name = "cbhcli_jupyter"

    # 允许其他扩展（如 jupyterlab）正常加载
    load_other_extensions = True

    def initialize_settings(self):
        """初始化扩展设置。"""
        # 让 handlers 能访问 ExtensionApp 实例
        self.settings["cbhcli_jupyter_app"] = self
        super().initialize_settings()

    def initialize_handlers(self):
        """注册 HTTP handlers（路径前缀 /cbhcli/）。"""
        self.handlers.extend(handlers)
        super().initialize_handlers()


# ---------------------------------------------------------------------------
#  jupyter_server 扩展点发现（jupyter_server 2.x 支持两种方式，都提供）
# ---------------------------------------------------------------------------

def _jupyter_server_extension_points():
    """声明扩展点（ExtensionApp 方式）。"""
    return [{"module": "cbhcli_jupyter"}]


def _load_jupyter_server_extension(server_app):
    """旧式加载方式（兼容）——委托给 ExtensionApp。"""
    CbhcliJupyterApp(server_app=server_app).initialize()


__all__ = ["CbhcliJupyterApp", "handlers"]

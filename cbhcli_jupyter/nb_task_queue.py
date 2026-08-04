"""UI 任务队列：后端 notebook 工具与前端 JupyterLab 面板之间的桥接。

设计动机：
- notebook 的 UI 状态（选中 cell、编辑器选区）只存在于 JupyterLab 前端；
- 后端 Agent 调用 notebook 工具时，需要前端执行实际 UI/内核操作；
- 本模块提供「后端创建任务 → 前端轮询获取 → 前端执行 → 回传结果」的通道。

线程安全说明：
- notebook 工具在后端线程池中执行（asyncio.to_thread），等待用 threading.Event；
- 前端轮询/回传 handler 在 jupyter_server 事件循环中执行，通过锁保护任务表。
"""

import threading
import time
import uuid
from typing import Optional


class UITask:
    """一个等待前端执行的 UI 操作任务。"""

    def __init__(self, action: str, params: dict, timeout: float = 300.0):
        self.task_id: str = uuid.uuid4().hex
        self.action: str = action
        self.params: dict = params or {}
        self.timeout: float = timeout
        self.created_at: float = time.time()
        self._done = threading.Event()
        self.result: Optional[dict] = None

    def wait(self) -> dict:
        """等待前端执行完成（超时返回失败结果）。"""
        self._done.wait(self.timeout)
        if not self._done.is_set():
            return {
                "success": False,
                "output": "",
                "error": (
                    f"前端执行超时（{self.timeout:.0f}s）。"
                    "请确认 JupyterLab 页面已打开且 cbhcli 侧边栏面板处于活动状态，"
                    "或通过面板按钮重试。"
                ),
            }
        return self.result or {"success": False, "output": "", "error": "无执行结果"}

    def complete(self, result: dict) -> None:
        """前端回传结果。"""
        self.result = result or {}
        self._done.set()


class UITaskQueue:
    """全局 UI 任务队列（单例，线程安全）。"""

    _instance: Optional["UITaskQueue"] = None
    _instance_lock = threading.Lock()

    def __new__(cls) -> "UITaskQueue":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init()
            return cls._instance

    def _init(self) -> None:
        self._tasks: dict[str, UITask] = {}
        self._mutex = threading.Lock()

    def create(self, action: str, params: dict, timeout: float = 300.0) -> UITask:
        """创建任务并返回（调用方负责 wait）。"""
        task = UITask(action, params, timeout)
        with self._mutex:
            self._cleanup()
            self._tasks[task.task_id] = task
        return task

    def pending(self, limit: int = 20) -> list:
        """获取所有待执行任务（前端轮询用）。超时任务自动标记失败。"""
        with self._mutex:
            now = time.time()
            items = []
            for tid, t in list(self._tasks.items()):
                if t._done.is_set():
                    continue
                if now - t.created_at > t.timeout:
                    t.complete({
                        "success": False, "output": "",
                        "error": f"后端等待超时（{t.timeout:.0f}s），任务已失效",
                    })
                    continue
                items.append({
                    "task_id": tid,
                    "action": t.action,
                    "params": t.params,
                })
                if len(items) >= limit:
                    break
            return items

    def complete(self, task_id: str, result: dict) -> bool:
        """前端回传任务结果。返回是否找到任务。"""
        with self._mutex:
            task = self._tasks.get(task_id)
            if task is None:
                return False
            task.complete(result)
            return True

    def _cleanup(self) -> None:
        """清理已完成/过期的任务（防止内存泄漏）。"""
        now = time.time()
        for tid in list(self._tasks):
            t = self._tasks[tid]
            if t._done.is_set() or now - t.created_at > max(t.timeout + 60, 600):
                del self._tasks[tid]


# 全局单例
task_queue = UITaskQueue()

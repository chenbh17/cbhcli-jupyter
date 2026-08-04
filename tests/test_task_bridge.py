"""测试 notebook 工具的任务桥机制（后端任务队列 ↔ 前端轮询/回传）。"""
import json
import sys
import threading
import time
import urllib.request

BASE = "http://localhost:8899/cbhcli/api"
TOKEN = "testtoken123"
COOKIE_FILE = "/tmp/ck.txt"
XSRF = [line.split()[-1] for line in open(COOKIE_FILE) if "_xsrf" in line][0]


def http(method, path, body=None):
    req = urllib.request.Request(
        f"{BASE}{path}?token={TOKEN}",
        data=json.dumps(body).encode() if body else None,
        headers={
            "Content-Type": "application/json",
            "X-XSRFToken": XSRF,
            "Cookie": open(COOKIE_FILE).read().replace("\n", "; "),
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


# 1. 后端创建任务（模拟 Agent 调用 notebook 工具）
from cbhcli_jupyter.nb_tools import NbGetSelectionTool, NbExecuteCellTool

result_box = {}

def run_tool(tool, params):
    try:
        result_box["result"] = tool.execute(**params)
    except Exception as e:
        result_box["error"] = str(e)

# 测试 1: nb_get_selection（无 notebook 打开时应快速失败或超时）
print("=== 测试 nb_get_selection（前端模拟）===")
t = threading.Thread(target=run_tool, args=(NbGetSelectionTool(), {}))
t.start()
time.sleep(0.5)

# 前端轮询
tasks = http("GET", "/notebook/pending")["tasks"]
print(f"  前端获取到任务: {len(tasks)} 个")
if tasks:
    tid = tasks[0]["task_id"]
    print(f"  任务 action: {tasks[0]['action']}")
    # 前端回传结果（模拟：没有 notebook → 失败）
    http("POST", "/notebook/result", {
        "task_id": tid,
        "result": {"success": False, "output": "", "error": "当前没有打开的 notebook"}
    })
t.join(timeout=5)
res = result_box.get("result")
print(f"  工具返回: success={res.success if res else '?'}, error={getattr(res, 'error', '')[:80] if res else '?'}")

# 测试 2: 直接回传成功结果
print("=== 测试 nb_list_cells 成功回传 ===")
result_box.clear()
t = threading.Thread(target=run_tool, args=(__import__('cbhcli_jupyter.nb_tools', fromlist=['NbListCellsTool']).NbListCellsTool(), {}))
t.start()
time.sleep(0.5)
tasks = http("GET", "/notebook/pending")["tasks"]
if tasks:
    tid = tasks[0]["task_id"]
    fake = {"success": True, "output": json.dumps({"cells": [{"index": 0, "type": "code", "code": "print(1)"}]}, ensure_ascii=False)}
    http("POST", "/notebook/result", {"task_id": tid, "result": fake})
t.join(timeout=5)
res = result_box.get("result")
print(f"  工具返回: success={res.success if res else '?'}")
if res and res.success:
    print(f"  输出: {res.output[:150]}")

print("\n✅ 任务桥机制测试完成")

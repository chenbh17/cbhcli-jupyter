"""端到端测试：AI 调用 notebook 工具 → 前端轮询回传 → AI 完成对话。"""
import json
import threading
import time
import urllib.request
import requests

BASE = "http://localhost:8899/cbhcli/api"
TOKEN = "testtoken123"
COOKIE_FILE = "/tmp/ck.txt"

# 解析 Netscape cookie 文件，只取 _xsrf
def _parse_cookies():
    pairs = []
    xsrf = ""
    for line in open(COOKIE_FILE):
        if line.startswith("#") or not line.strip():
            continue
        parts = line.strip().split("\t")
        if len(parts) >= 7:
            name, value = parts[5], parts[6]
            pairs.append(f"{name}={value}")
            if name == "_xsrf":
                xsrf = value
    return "; ".join(pairs), xsrf

COOKIE, XSRF = _parse_cookies()
HEADERS = {"Content-Type": "application/json", "X-XSRFToken": XSRF, "Cookie": COOKIE}

stop_polling = threading.Event()


def poll_and_respond():
    """模拟前端：轮询 pending 任务并回传成功结果。"""
    while not stop_polling.is_set():
        try:
            resp = requests.get(f"{BASE}/notebook/pending?token={TOKEN}",
                                headers=HEADERS, timeout=5)
            tasks = resp.json().get("tasks", [])
            for t in tasks:
                fake = {
                    "success": True,
                    "output": json.dumps({
                        "cells": [{
                            "index": 0, "id": "cell-test",
                            "type": "code",
                            "code": "print('hello from notebook')",
                            "selected_text": "print('hello')",
                        }],
                        "notebook_path": "test.ipynb",
                    }, ensure_ascii=False),
                    "data": {},
                }
                requests.post(f"{BASE}/notebook/result?token={TOKEN}",
                              json={"task_id": t["task_id"], "result": fake},
                              headers=HEADERS, timeout=5)
                print(f"  [前端] 已执行任务 {t['action']} → {t['task_id'][:8]} 并回传")
        except Exception as e:
            print(f"  [前端] 轮询异常: {e}")
        time.sleep(0.2)


# 启动模拟前端
threading.Thread(target=poll_and_respond, daemon=True).start()

# 发送聊天：让 AI 使用 notebook 工具
print("=== 发送聊天（AI 应调用 nb_get_selection）===")
resp = requests.post(
    f"{BASE}/chat?token={TOKEN}",
    json={"agent_name": "main", "model_name": "deepseek-v4-flash",
          "message": "请调用 nb_get_selection 工具查看当前 notebook 中选中的代码，然后告诉我代码内容"},
    headers=HEADERS,
    stream=True,
    timeout=120,
)
seen_tools = set()
for line in resp.iter_lines(decode_unicode=True):
    if not line or not line.startswith("data:"):
        continue
    try:
        ev = json.loads(line[5:].strip())
    except Exception:
        continue
    if ev.get("type") == "tool_confirm":
        print(f"  [SSE] 工具调用: {ev['tool_name']} (needs_confirm={ev['needs_confirm']})")
        seen_tools.add(ev["tool_name"])
    elif ev.get("type") == "tool_result":
        ok = ev.get("success")
        print(f"  [SSE] 工具结果: {ev.get('tool_name')} success={ok}")
        if ev.get("preview"):
            print(f"        preview: {str(ev['preview'])[:120]}")
    elif ev.get("type") == "content":
        print(f"  [SSE] 内容: {ev['content']}", end="")
    elif ev.get("type") == "done":
        print(f"\n  [SSE] done (usage: {ev.get('usage', {}).get('token_estimate')} tokens)")
        break
    elif ev.get("type") == "error":
        print(f"  [SSE] error: {ev.get('content')}")
        break

stop_polling.set()
print("\n=== 完成 ===")

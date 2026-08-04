"""通过 Chrome DevTools Protocol 验证 JupyterLab 左侧栏状态。"""
import json
import time
import urllib.request
import websocket

# 1. 启动 headless chromium（带远程调试）
import subprocess
import os

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9223
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*",
    f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1400,900",
    "http://localhost:8899/lab?token=testtoken123",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    # 等待 CDP 就绪
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(
                f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs:
                break
        except Exception:
            pass
        time.sleep(1)
    if not tabs:
        print("❌ CDP 未就绪")
        sys.exit(1)

    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
    msg_id = 0

    def evaluate(expr):
        global msg_id
        msg_id += 1
        ws.send(json.dumps({
            "id": msg_id, "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True},
        }))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == msg_id:
                return resp.get("result", {}).get("result", {}).get("value")

    # 等待 JupyterLab 加载
    time.sleep(15)

    # 检查左侧 tab
    tabs_js = """
    Array.from(document.querySelectorAll('.lm-TabBar-tab')).map(t => ({
        id: t.getAttribute('data-id'),
        title: t.getAttribute('title'),
        hasSvg: !!t.querySelector('svg')
    }))
    """
    result = evaluate(tabs_js)
    print("=== 左侧 TabBar tab ===")
    for t in result or []:
        print(f"  id={t['id']} title={t['title']!r} svg={t['hasSvg']}")

    # 检查 cbhcli-panel
    panel_js = """
    (() => {
        const el = document.getElementById('cbhcli-jupyter-panel');
        if (!el) return {exists: false};
        return {
            exists: true,
            parentId: el.parentElement?.id,
            parentClass: el.parentElement?.className?.slice(0, 80),
            hidden: el.classList.contains('lm-mod-hidden')
        };
    })()
    """
    print("\n=== cbhcli-panel ===")
    print(" ", evaluate(panel_js))

    # 检查文件浏览器
    fb_js = """
    (() => {
        const el = document.getElementById('filebrowser');
        return el ? {exists: true, hidden: el.classList.contains('lm-mod-hidden')} : {exists: false};
    })()
    """
    print("\n=== 文件浏览器 ===")
    print(" ", evaluate(fb_js))

finally:
    proc.terminate()

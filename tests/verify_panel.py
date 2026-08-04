"""CDP 最终验证：点击 cbhcli tab → 面板显示 → 前端 API 认证 → 完整聊天。"""
import json
import subprocess
import sys
import time
import urllib.request
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9224

proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*",
    f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1400,900",
    "http://localhost:8899/lab?token=testtoken123",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    tabs = []
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(
                f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs:
                break
        except Exception:
            pass
        time.sleep(1)
    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
    msg_id = 0

    def evaluate(expr):
        global msg_id
        msg_id += 1
        ws.send(json.dumps({
            "id": msg_id, "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True,
                       "awaitPromise": True},
        }))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == msg_id:
                r = resp.get("result", {}).get("result", {})
                if r.get("exceptionDetails"):
                    return {"error": r["exceptionDetails"]["text"]}
                return r.get("value")

    time.sleep(12)

    # 1. 点击 cbhcli tab
    print("=== 1. 点击 cbhcli tab ===")
    click_js = """
    (() => {
        const tabs = Array.from(document.querySelectorAll('.lm-TabBar-tab'));
        const tab = tabs.find(t => t.getAttribute('data-id') === 'cbhcli-jupyter-panel');
        if (!tab) return 'tab 未找到';
        tab.click();
        return '已点击';
    })()
    """
    print(" ", evaluate(click_js))
    time.sleep(2)

    # 2. 检查面板是否显示
    panel_js = """
    (() => {
        const el = document.getElementById('cbhcli-jupyter-panel');
        if (!el) return {exists: false};
        return {
            exists: true,
            hidden: el.classList.contains('lm-mod-hidden'),
            childCount: el.childElementCount
        };
    })()
    """
    print("=== 2. 面板状态 ===")
    print(" ", evaluate(panel_js))

    # 3. 前端 API 认证测试（模拟前端 fetch，带 XSRF）
    api_js = """
    (async () => {
        const resp = await fetch('/cbhcli/api/info');
        if (!resp.ok) return {status: resp.status, error: await resp.text().catch(() => '')};
        return {status: resp.status, data: await resp.json()};
    })()
    """
    print("=== 3. 前端 API 认证 ===")
    print(" ", evaluate(api_js))

    # 4. 面板内 UI 状态（模型下拉是否加载）
    ui_js = """
    (() => {
        const sel = document.querySelector('.cbhcli-header-select');
        if (!sel) return {selectExists: false};
        return {
            selectExists: true,
            options: Array.from(sel.options).map(o => o.value).slice(0, 5),
            statusText: document.querySelector('.cbhcli-statusbar')?.textContent?.slice(0, 60)
        };
    })()
    """
    print("=== 4. 面板 UI ===")
    print(" ", evaluate(ui_js))

finally:
    proc.terminate()

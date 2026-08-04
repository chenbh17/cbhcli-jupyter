"""用 CDP Input.dispatchMouseEvent 真实点击 cbhcli 图标，验证面板激活。"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9226
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    "http://localhost:8899/lab?token=testtoken123",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    tabs = []
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs: break
        except Exception: pass
        time.sleep(1)
    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
    msg_id = 0
    def cdp(method, params=None):
        global msg_id
        msg_id += 1
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == msg_id:
                return resp.get("result", {})
    def evaluate(expr):
        return cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True}).get("result", {}).get("value")

    time.sleep(18)

    # 取 cbhcli tab 中心坐标
    rect = evaluate("""
    (() => {
        const tab = Array.from(document.querySelectorAll('.lm-TabBar-tab'))
            .find(t => t.getAttribute('data-id') === 'cbhcli-jupyter-panel');
        if (!tab) return null;
        const r = tab.getBoundingClientRect();
        return {x: r.x + r.width/2, y: r.y + r.height/2};
    })()
    """)
    print("cbhcli tab 坐标:", rect)
    if not rect:
        print("❌ 未找到 tab"); sys.exit(1)

    x, y = int(rect['x']), int(rect['y'])
    # 受信任的鼠标点击
    cdp("Input.dispatchMouseEvent", {"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})
    cdp("Input.dispatchMouseEvent", {"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})
    time.sleep(3)

    print("\n=== 点击后状态 ===")
    print("当前激活 tab:", evaluate("document.querySelector('.lm-TabBar-tab.lm-mod-current')?.getAttribute('data-id')"))
    print(evaluate("""
    (() => {
        const p = document.getElementById('cbhcli-jupyter-panel');
        if (!p) return 'panel not found';
        const r = p.getBoundingClientRect();
        return {hidden: p.classList.contains('lm-mod-hidden'), w: Math.round(r.width), h: Math.round(r.height)};
    })()
    """))

    # 面板内关键组件可见性
    print("\n=== 面板内组件（激活后） ===")
    for name, expr in {
        "动作按钮数": "document.querySelectorAll('.cbhcli-chip-btn').length",
        "上下文分数": "document.querySelector('.cbhcli-ctx-fraction')?.textContent",
        "路径": "document.querySelector('.cbhcli-path-bar')?.textContent",
        "输入框可见": "!!document.querySelector('.cbhcli-input')?.offsetParent",
    }.items():
        print(f"  {name}: {evaluate(expr)}")

finally:
    proc.terminate()

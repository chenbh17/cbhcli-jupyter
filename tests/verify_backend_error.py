"""v0.3.3 前端验证：后端错误横幅。

正常模式（cbhcli 已装）：横幅隐藏、Agent/模型下拉有数据。
降级模式（cbhcli_pkg 不可导入）：横幅显示 + 含安装指引、下拉为空。
"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9229
URL = "http://localhost:8899/lab?token=testtoken123"

proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    URL,
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
    tabs = []
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs:
                break
        except Exception:
            pass
        time.sleep(1)
    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
    msg_id = 0

    def cdp(method, params=None):
        nonlocal msg_id
        msg_id += 1
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == msg_id:
                return resp.get("result", {})

    def evaluate(expr):
        return cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")

    time.sleep(18)  # 等 JupyterLab + 插件加载

    # 打开 cbhcli 侧边栏面板（受信任点击）
    cdp("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 30, "y": 300, "button": "left", "clickCount": 1})
    cdp("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": 30, "y": 300, "button": "left", "clickCount": 1})
    # 兜底：命令面板方式激活
    evaluate("""(() => {
      const app = window.jupyterlab;
      if (app) { try { app.commands.execute('cbhcli-jupyter:open'); } catch(e) {} }
    })()""")
    time.sleep(3)

    banner_hidden = evaluate("document.querySelector('.cbhcli-backend-error')?.classList.contains('cbhcli-hidden')")
    banner_exists = evaluate("!!document.querySelector('.cbhcli-backend-error')")
    banner_text = evaluate("document.querySelector('.cbhcli-backend-error')?.innerText || ''")
    agent_opts = evaluate("document.querySelectorAll('.cbhcli-header-select')[0]?.options.length || 0")
    model_opts = evaluate("document.querySelectorAll('.cbhcli-header-select')[1]?.options.length || 0")

    print(f"模式: {mode}")
    print(f"横幅元素存在: {banner_exists}")
    print(f"横幅隐藏(cbhcli-hidden): {banner_hidden}")
    print(f"Agent 下拉选项数: {agent_opts}")
    print(f"模型 下拉选项数: {model_opts}")
    if banner_text:
        print(f"横幅文本前 120 字: {banner_text[:120]!r}")

    if mode == "normal":
        ok = banner_hidden is True and agent_opts > 0 and model_opts > 0
        print("\n" + ("✓ 正常模式验证通过：横幅隐藏，下拉有数据" if ok else "✗ 正常模式验证失败"))
    else:
        ok = banner_hidden is False and "cbhcli" in banner_text and ("安装" in banner_text or "whl" in banner_text)
        print("\n" + ("✓ 降级模式验证通过：横幅显示且含安装指引" if ok else "✗ 降级模式验证失败"))
    sys.exit(0 if ok else 1)

try:
    main()
finally:
    proc.terminate()

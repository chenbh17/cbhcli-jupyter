"""验证需求8：打开文件→选中文本→小眼睛出现并显示行列信息。"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9229
# 通过 /lab/tree/ 直接打开文件到编辑器
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    "http://localhost:8899/lab/tree/test_sel.py?token=testtoken123",
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
        return cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")
    def click_selector(selector):
        rect = evaluate(f"""(() => {{ const e=document.querySelector('{selector}');
            if(!e) return null; const r=e.getBoundingClientRect();
            return {{x:r.x+r.width/2, y:r.y+r.height/2}}; }})()""")
        if not rect: return False
        x,y=int(rect['x']),int(rect['y'])
        cdp("Input.dispatchMouseEvent", {"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})
        cdp("Input.dispatchMouseEvent", {"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})
        return True

    time.sleep(18)
    print("文件编辑器已打开:", evaluate("!!document.querySelector('.cm-editor')"))

    # 激活 cbhcli 面板
    for _ in range(4):
        click_selector(".lm-TabBar-tab[data-id='cbhcli-jupyter-panel']")
        time.sleep(1.5)
        if evaluate("!document.getElementById('cbhcli-jupyter-panel')?.classList.contains('lm-mod-hidden')"):
            break

    # 先单击编辑器让焦点进入，再双击一个单词制造选区
    print("\n=== 双击选词制造选区 ===")
    # 找到 'compute_score' 文本坐标
    coord = evaluate("""
    (() => {
        const content = document.querySelector('.cm-content');
        if (!content) return null;
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
            const idx = node.textContent.indexOf('compute_score');
            if (idx !== -1) {
                const range = document.createRange();
                range.setStart(node, idx);
                range.setEnd(node, idx + 13);
                const r = range.getBoundingClientRect();
                return {x: r.x + r.width/2, y: r.y + r.height/2};
            }
        }
        return null;
    })()
    """)
    print("目标词坐标:", coord)
    if coord:
        x, y = int(coord['x']), int(coord['y'])
        # 双击（clickCount=2）选中单词
        cdp("Input.dispatchMouseEvent", {"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":2})
        cdp("Input.dispatchMouseEvent", {"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":2})

    # 等待 400ms 轮询检测
    time.sleep(2)
    print("编辑器当前选区:", evaluate("""
    (() => { const s = window.getSelection(); return s ? s.toString().slice(0,40) : 'none'; })()
    """))

    print("\n=== 小眼睛状态 ===")
    print("eye 显示:", evaluate("!document.querySelector('.cbhcli-eye-wrap')?.classList.contains('cbhcli-hidden')"))
    print("eye 信息:", evaluate("document.querySelector('.cbhcli-eye-info')?.textContent"))
    print("eye 按钮 on:", evaluate("document.querySelector('.cbhcli-eye-btn')?.classList.contains('on')"))

    # 点击眼睛关闭
    print("\n=== 点击眼睛关闭 ===")
    evaluate("document.querySelector('.cbhcli-eye-btn')?.click()")
    time.sleep(1)
    print("eye 按钮 off:", evaluate("document.querySelector('.cbhcli-eye-btn')?.classList.contains('off')"))

    # 验证选中上下文注入（发送时）
    print("\n=== 打开眼睛并发送，验证上下文注入 ===")
    evaluate("document.querySelector('.cbhcli-eye-btn')?.click()")  # 重新打开
    time.sleep(0.5)
    evaluate("const i=document.querySelector('.cbhcli-input'); i.value='这段代码做了什么'")
    evaluate("document.querySelector('.cbhcli-btn-primary')?.click()")
    time.sleep(2)
    print("用户气泡含选区提示:", evaluate("!!document.querySelector('.cbhcli-msg-sel-note')"))
    print("选区提示文本:", evaluate("document.querySelector('.cbhcli-msg-sel-note')?.textContent"))

finally:
    proc.terminate()

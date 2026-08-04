"""最终验证：工具/Skills 弹窗内容 + 勾选交互 + 发送消息（直连 .click()）。"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9228
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
        return cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")

    time.sleep(18)

    # 1. 工具弹窗（直连 click）
    print("=== 工具弹窗 ===")
    evaluate("Array.from(document.querySelectorAll('.cbhcli-chip-btn')).find(b=>b.textContent.includes('工具'))?.click()")
    time.sleep(3)
    print("弹窗存在:", evaluate("!!document.querySelector('.cbhcli-dialog-wide')"))
    print("勾选项数:", evaluate("document.querySelectorAll('.cbhcli-check-row').length"))
    print("分组:", evaluate("Array.from(document.querySelectorAll('.cbhcli-modal-group')).map(g=>g.textContent).join(' | ')"))
    print("启用状态标签:", evaluate("Array.from(document.querySelectorAll('.cbhcli-check-state')).slice(0,3).map(s=>s.textContent).join(',')"))
    # 勾选状态统计
    print("已启用数:", evaluate("document.querySelectorAll('.cbhcli-check-row.on').length"),
          "/ 总数:", evaluate("document.querySelectorAll('.cbhcli-check-row').length"))
    evaluate("document.querySelector('.cbhcli-dialog-close')?.click()")
    time.sleep(1)

    # 2. Skills 弹窗
    print("\n=== Skills 弹窗 ===")
    evaluate("Array.from(document.querySelectorAll('.cbhcli-chip-btn')).find(b=>b.textContent.includes('Skills'))?.click()")
    time.sleep(3)
    print("弹窗存在:", evaluate("!!document.querySelector('.cbhcli-dialog-wide')"))
    print("skills 项数:", evaluate("document.querySelectorAll('.cbhcli-check-row').length"))
    print("skills 名称:", evaluate("Array.from(document.querySelectorAll('.cbhcli-check-name')).map(n=>n.textContent).join(', ')"))
    print("激活状态:", evaluate("Array.from(document.querySelectorAll('.cbhcli-check-state')).map(s=>s.textContent).join(',')"))
    evaluate("document.querySelector('.cbhcli-dialog-close')?.click()")
    time.sleep(1)

    # 3. 发送消息（直连 click）
    print("\n=== 发送消息 ===")
    evaluate("const i=document.querySelector('.cbhcli-input'); i.value='你好，请只回复ok'; i.dispatchEvent(new Event('input'))")
    evaluate("document.querySelector('.cbhcli-btn-primary')?.click()")
    time.sleep(8)
    print("用户消息气泡:", evaluate("!!document.querySelector('.cbhcli-msg-user')"))
    print("用户消息文本:", evaluate("document.querySelector('.cbhcli-msg-text')?.textContent?.slice(0,40)"))
    print("AI容器:", evaluate("!!document.querySelector('.cbhcli-msg-ai')"))
    print("消息区内容(前250):", evaluate("document.querySelector('.cbhcli-messages')?.textContent?.slice(0,250)"))
    print("上下文分数(会话后):", evaluate("document.querySelector('.cbhcli-ctx-fraction')?.textContent"))

    # 4. 小眼睛
    print("\n=== 小眼睛（无选区） ===")
    print("eye hidden:", evaluate("document.querySelector('.cbhcli-eye-wrap')?.classList.contains('cbhcli-hidden')"))

finally:
    proc.terminate()

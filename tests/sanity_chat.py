"""问答页 sanity：发一条简单消息，确认 AI 正常回复（SSE 流程未被 api_handler 改动影响）。"""
import json, time, urllib.request, subprocess
import websocket
CHROME = "/snap/bin/chromium"; DEBUG_PORT = 9258
proc = subprocess.Popen([CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950", "http://localhost:8899/lab?token=testtoken123"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    tabs = []
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs: break
        except Exception: pass
        time.sleep(1)
    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
    mid = [0]
    def cdp(m, p=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]: return r.get("result", {})
    def ev(x):
        return cdp("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")
    time.sleep(18)
    print("面板就绪:", ev("!!document.querySelector('.cbhcli-input')"))
    ev(r"""(()=>{const i=document.querySelector('.cbhcli-input');i.value='请用一句话回答：1+1等于几？';i.dispatchEvent(new Event('input'));document.querySelector('.cbhcli-btn-primary')?.click();return 'sent'})()""")
    last=-1; stable=0
    for _ in range(40):
        time.sleep(1)
        ln = ev("(document.querySelector('.cbhcli-msg-ai')?.textContent||'').length")
        if ln==last and ln>0:
            stable+=1
            if stable>=3: break
        else: stable=0
        last=ln
    reply = ev("document.querySelector('.cbhcli-msg-ai')?.textContent||''")
    print("回复长度:", last)
    print("回复片段:", (reply or "")[:80])
    print("✅ 问答正常" if last > 0 else "❌ 无回复")
finally:
    proc.terminate()

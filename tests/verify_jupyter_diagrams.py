"""v0.2.13 Jupyter 验证：AI 回复中的 ```mermaid / ```echarts 代码块在回复完成后渲染为 SVG / canvas。
端到端：发送真实消息 → 等待回复完成（onEnd 触发 renderDiagrams）→ 检查 .cbh-mermaid svg / .cbh-echarts canvas。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9251
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
            if tabs:
                break
        except Exception:
            pass
        time.sleep(1)
    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=180)
    mid = [0]

    def cdp(m, p=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r.get("result", {})

    def ev(x):
        return cdp("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")

    time.sleep(18)
    print("面板就绪:", ev("!!document.querySelector('.cbhcli-input')"))

    # 让 AI 输出一个 mermaid 流程图代码块 + 一个 echarts 柱状图配置代码块
    ev(r"""(()=>{ const i=document.querySelector('.cbhcli-input');
      i.value='请只回复两个代码块，不要其他内容：第一个是 mermaid 代码块（```mermaid 开头），内容为一个简单流程图 graph TD; A-->B; 第二个是 echarts 代码块（```echarts 开头），内容为一个柱状图 JSON 配置 {"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]}。';
      i.dispatchEvent(new Event('input'));
      document.querySelector('.cbhcli-btn-primary')?.click(); return 'sent'; })()""")
    print("消息已发送，等待回复…")

    last_len = -1
    stable = 0
    for _ in range(60):
        time.sleep(1)
        ln = ev("(document.querySelector('.cbhcli-msg-ai')?.textContent||'').length")
        if ln == last_len and ln > 0:
            stable += 1
            if stable >= 4:
                break
        else:
            stable = 0
        last_len = ln
    print("回复长度:", last_len)
    # 回复完成后 onEnd 触发 renderDiagrams（mermaid 异步 + 懒加载 chunk），额外等待
    time.sleep(6)

    print("\n=== 渲染检查 ===")
    ai = "document.querySelector('.cbhcli-msg-ai')"
    print(".cbh-mermaid 容器数(应≥1):", ev(f"{ai}.querySelectorAll('.cbh-mermaid').length"))
    print("mermaid SVG 数(应≥1):", ev(f"{ai}.querySelectorAll('.cbh-mermaid svg').length"))
    print(".cbh-echarts 容器数(应≥1):", ev(f"{ai}.querySelectorAll('.cbh-echarts').length"))
    print("echarts canvas 数(应≥1):", ev(f"{ai}.querySelectorAll('.cbh-echarts canvas').length"))
    print("剩余 language-mermaid 代码块(应 0):", ev(f"{ai}.querySelectorAll('code.language-mermaid').length"))
    print("剩余 language-echarts 代码块(应 0):", ev(f"{ai}.querySelectorAll('code.language-echarts').length"))

    mmd_svg = ev(f"{ai}.querySelectorAll('.cbh-mermaid svg').length") or 0
    ec_canvas = ev(f"{ai}.querySelectorAll('.cbh-echarts canvas').length") or 0
    left_mmd = ev(f"{ai}.querySelectorAll('code.language-mermaid').length") or 0
    left_ec = ev(f"{ai}.querySelectorAll('code.language-echarts').length") or 0
    ok = mmd_svg >= 1 and ec_canvas >= 1 and left_mmd == 0 and left_ec == 0
    print("\n✅ 验证通过（mermaid→SVG / echarts→canvas / 代码块已替换）" if ok else "❌ 验证失败（可能 AI 未按要求输出代码块，或渲染未触发）")

finally:
    proc.terminate()

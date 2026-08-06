"""端到端探针（带 console 捕获）：让 AI 输出 3 个不同 mermaid + 1 个 echarts，报告哪些渲染了 + console 报错。"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9253
URL = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8899/lab?token=testtoken123"
SEL = sys.argv[3] if len(sys.argv) > 3 else ".cbhcli-msg-ai"   # jupyter
BTN = sys.argv[4] if len(sys.argv) > 4 else ".cbhcli-btn-primary"
INP = sys.argv[5] if len(sys.argv) > 5 else ".cbhcli-input"

proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950", URL,
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

console_msgs = []
try:
    tabs = []
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs: break
        except Exception: pass
        time.sleep(1)
    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=180)
    mid = [0]
    def cdp(m, p=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            # 收集 console 事件
            if r.get("method") == "Runtime.consoleAPICalled":
                args = r.get("params", {}).get("args", [])
                txt = " ".join(str(a.get("value", a.get("description", ""))) for a in args)
                console_msgs.append(txt)
                continue
            if r.get("method") == "Runtime.exceptionThrown":
                ed = r.get("params", {}).get("exceptionDetails", {})
                console_msgs.append("EXC: " + str(ed.get("text")) + " " + str(ed.get("exception", {}).get("description", ""))[:200])
                continue
            if r.get("id") == mid[0]: return r.get("result", {})
    def ev(x):
        return cdp("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")

    cdp("Runtime.enable")
    time.sleep(18)
    print("面板就绪:", ev(f"!!document.querySelector('{INP}')"))

    ev(r"""(()=>{ const i=document.querySelector('""" + INP + r"""');
      i.value='请只回复四个代码块，不要任何其他文字：1) 一个 ```mermaid 流程图(graph TD; A-->B; B-->C)；2) 一个 ```mermaid 时序图(sequenceDiagram, A->>B: hello)；3) 一个 ```mermaid 饼图(pie title T, "A":60,"B":40)；4) 一个 ```echarts 柱状图JSON配置({"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]})。每个代码块用对应的语言标记开头。';
      i.dispatchEvent(new Event('input'));
      document.querySelector('""" + BTN + r"""')?.click(); return 'sent'; })()""")
    print("已发送，等待回复…")

    last_len = -1; stable = 0
    for _ in range(70):
        time.sleep(1)
        ln = ev(f"(document.querySelector('{SEL}')?.textContent||'').length")
        if ln == last_len and ln > 0:
            stable += 1
            if stable >= 4: break
        else: stable = 0
        last_len = ln
    print("回复长度:", last_len)
    time.sleep(7)

    ai = f"document.querySelector('{SEL}')"
    print("\n=== 渲染结果 ===")
    print("mermaid SVG 数:", ev(f"{ai}.querySelectorAll('.cbh-mermaid svg').length"))
    print("echarts canvas 数:", ev(f"{ai}.querySelectorAll('.cbh-echarts canvas').length"))
    print("剩余 language-mermaid 代码块:", ev(f"{ai}.querySelectorAll('code.language-mermaid').length"))
    print("剩余 language-echarts 代码块:", ev(f"{ai}.querySelectorAll('code.language-echarts').length"))
    print("所有代码块语言标记:", ev(f"Array.from({ai}.querySelectorAll('pre code')).map(c=>c.className).join(',')"))
    print("AI 回复中出现的所有 ``` 标记:", ev(f"(document.querySelector('{SEL}')?.innerText||'').match(/```\\w*/g)?.join(',')||'none'"))

    print("\n=== console 报错/警告（mermaid/echarts 相关）===")
    for m in console_msgs:
        if any(k in m.lower() for k in ["mermaid", "echarts", "error", "exc", "fail", "parse"]):
            print(" ", m[:300])
    if not any(any(k in m.lower() for k in ["mermaid","echarts","error","exc"]) for m in console_msgs):
        print("  (无相关报错)")

finally:
    proc.terminate()

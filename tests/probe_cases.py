"""批量探测内容相关失败：多种 mermaid（中文/各类型）+ echarts 不同标签，走 web 真实管线。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9254
proc = subprocess.Popen([CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950", "http://localhost:18888/"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
    mid = [0]
    def cdp(m, p=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("method") == "Runtime.consoleAPICalled":
                args = r.get("params", {}).get("args", [])
                console_msgs.append(" ".join(str(a.get("value", a.get("description", ""))) for a in args)); continue
            if r.get("id") == mid[0]: return r.get("result", {})
    def ev(x):
        return cdp("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": True}).get("result", {}).get("value")
    cdp("Runtime.enable")
    time.sleep(8)

    # 每个用例单独一个容器，独立调用 renderDiagrams，报告该块是否渲染
    cases = [
        ("mermaid 中文节点", "mermaid", "graph TD;\n  A[开始]-->B{判断};\n  B-->|是|C[结束];"),
        ("mermaid 中文裸节点(无括号)", "mermaid", "graph TD;\n  开始-->结束;"),
        ("mermaid flowchart", "mermaid", "flowchart LR\n  A --> B"),
        ("mermaid 时序图", "mermaid", "sequenceDiagram\n  张三->>李四: 你好"),
        ("mermaid 饼图", "mermaid", 'pie title 占比\n  "A" : 60\n  "B" : 40'),
        ("mermaid 带标题空行", "mermaid", "\ngraph TD; A-->B;\n"),
        ("echarts 标准tag", "echarts", '{"xAxis":{"type":"category","data":["A"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1]}]}'),
        ("echarts json tag", "json", '{"xAxis":{"type":"category","data":["A"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1]}]}'),
        ("echarts javascript option=", "javascript", 'option = {\n  xAxis: {type:"category",data:["A"]},\n  yAxis: {type:"value"},\n  series: [{type:"bar",data:[1]}]\n};'),
        ("echarts 尾逗号", "echarts", '{"xAxis":{"type":"category","data":["A",]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1]},]}'),
    ]
    for name, lang, body in cases:
        expr = ("(async()=>{const c=document.createElement('div');c.className='md-content';"
                "c.innerHTML=renderMd('```" + lang + "\\n" + body.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "\\n```');"
                "enhanceCodeBlocks(c);document.body.appendChild(c);await renderDiagrams(c);"
                "await new Promise(r=>setTimeout(r,300));"
                "return {svg:c.querySelectorAll('.cbh-mermaid svg').length,canvas:c.querySelectorAll('.cbh-echarts canvas').length,pre:c.querySelectorAll('pre').length};})()")
        r = ev(expr) or {}
        rendered = (r.get("svg", 0) + r.get("canvas", 0)) >= 1
        print(f"{'✅' if rendered else '❌'} {name:28s} svg={r.get('svg')} canvas={r.get('canvas')} 残留pre={r.get('pre')}")

    print("\n=== mermaid/echarts console 报错 ===")
    for m in console_msgs:
        if any(k in m.lower() for k in ["mermaid", "echarts", "parse", "syntax", "expect"]):
            print(" ", m[:200])
finally:
    proc.terminate()

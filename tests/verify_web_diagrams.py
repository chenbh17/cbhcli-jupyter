"""v5.2.0 Web 验证：renderDiagrams 把 ```mermaid / ```echarts 代码块渲染为 SVG / canvas。
直接调用全局 renderDiagrams（不依赖 AI 生成），并验证懒加载、失败回退。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9250
URL = "http://localhost:18888/"
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950", URL,
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
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
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

    time.sleep(8)
    print("页面就绪:", ev("!!document.querySelector('#chat-view') || !!document.body"))
    print("renderDiagrams 全局函数存在:", ev("typeof renderDiagrams === 'function'"))
    print("初始 window.mermaid(懒加载，应为 undefined):", ev("typeof window.mermaid"))
    print("初始 window.echarts(懒加载，应为 undefined):", ev("typeof window.echarts"))

    # 构造测试容器：1 个 mermaid 块 + 1 个 echarts 块 + 1 个语法错误的 mermaid 块
    setup = r"""(async () => {
      const c = document.createElement('div');
      c.id = 'diag-test';
      c.innerHTML =
        '<pre><code class="language-mermaid">graph TD;\n  A[开始]-->B{判断};\n  B-->|是|C[结束];</code></pre>' +
        '<pre><code class="language-echarts">{"title":{"text":"测试"},"xAxis":{"type":"category","data":["A","B","C"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2,3]}]}</code></pre>' +
        '<pre><code class="language-mermaid">this is not a valid mermaid diagram @@@</code></pre>';
      document.body.appendChild(c);
      await renderDiagrams(c);
      // 给 echarts 一点时间绘制
      await new Promise(r => setTimeout(r, 500));
      return {
        mermaidLoaded: typeof window.mermaid !== 'undefined',
        echartsLoaded: typeof window.echarts !== 'undefined',
        mermaidDivs: c.querySelectorAll('.cbh-mermaid').length,
        mermaidSvg: c.querySelectorAll('.cbh-mermaid svg').length,
        echartsDivs: c.querySelectorAll('.cbh-echarts').length,
        echartsCanvas: c.querySelectorAll('.cbh-echarts canvas').length,
        remainingPre: c.querySelectorAll('pre').length,
        badBlockKept: Array.from(c.querySelectorAll('pre code')).some(x => x.textContent.includes('not a valid mermaid'))
      };
    })()"""
    r = ev(setup) or {}
    print("\n=== 渲染结果 ===")
    print("mermaid 懒加载成功:", r.get("mermaidLoaded"))
    print("echarts 懒加载成功:", r.get("echartsLoaded"))
    print(".cbh-mermaid 容器数(应≥1):", r.get("mermaidDivs"))
    print("mermaid SVG 数(应≥1):", r.get("mermaidSvg"))
    print(".cbh-echarts 容器数(应 1):", r.get("echartsDivs"))
    print("echarts canvas 数(应 1):", r.get("echartsCanvas"))
    print("剩余 <pre> 数(应 1=失败块):", r.get("remainingPre"))
    print("语法错误 mermaid 保留为代码:", r.get("badBlockKept"))

    ok = (r.get("mermaidLoaded") and r.get("echartsLoaded")
          and (r.get("mermaidSvg") or 0) >= 1
          and (r.get("echartsCanvas") or 0) >= 1
          and r.get("badBlockKept"))
    print("\n✅ 验证通过（mermaid→SVG / echarts→canvas / 懒加载 / 失败回退）" if ok else "❌ 验证失败")

finally:
    proc.terminate()

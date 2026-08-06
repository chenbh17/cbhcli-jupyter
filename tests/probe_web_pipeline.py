"""复现：走真实管线 renderMd -> enhanceCodeBlocks -> renderDiagrams，诊断 echarts 不渲染 + 多 mermaid。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9252
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950", "http://localhost:18888/",
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

    time.sleep(8)

    probe = r"""(async () => {
      const text = '前面文字\n\n```mermaid\ngraph TD; A-->B;\n```\n\n中间\n\n```mermaid\nsequenceDiagram\n  A->>B: hello\n  B-->>A: hi\n```\n\n再一个\n\n```mermaid\npie title 占比\n  "A" : 60\n  "B" : 40\n```\n\n```echarts\n{"title":{"text":"t"},"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]}\n```\n';
      const c = document.createElement('div');
      c.className = 'md-content';
      c.innerHTML = renderMd(text);
      // 诊断1：renderMd 后的代码块 class
      const afterMd = {
        mermaid: c.querySelectorAll('code.language-mermaid').length,
        echarts: c.querySelectorAll('code.language-echarts').length,
        allCodeClasses: Array.from(c.querySelectorAll('pre code')).map(x => x.className)
      };
      enhanceCodeBlocks(c);
      const afterHl = {
        mermaid: c.querySelectorAll('code.language-mermaid').length,
        echarts: c.querySelectorAll('code.language-echarts').length,
        echartsText: (c.querySelector('code.language-echarts')?.textContent || '').slice(0, 60)
      };
      document.body.appendChild(c);
      await renderDiagrams(c);
      await new Promise(r => setTimeout(r, 600));
      const afterRender = {
        mermaidSvg: c.querySelectorAll('.cbh-mermaid svg').length,
        echartsCanvas: c.querySelectorAll('.cbh-echarts canvas').length,
        remainingPre: c.querySelectorAll('pre').length,
        remainingMermaidCode: c.querySelectorAll('code.language-mermaid').length,
        remainingEchartsCode: c.querySelectorAll('code.language-echarts').length
      };
      return { afterMd, afterHl, afterRender };
    })()"""
    r = ev(probe) or {}
    print("=== renderMd 后 ===")
    print(json.dumps(r.get("afterMd"), ensure_ascii=False))
    print("=== enhanceCodeBlocks 后 ===")
    print(json.dumps(r.get("afterHl"), ensure_ascii=False))
    print("=== renderDiagrams 后 ===")
    print(json.dumps(r.get("afterRender"), ensure_ascii=False))

finally:
    proc.terminate()

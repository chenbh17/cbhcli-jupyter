"""验证 图片/代码 切换按钮：工具栏2按钮、点击切换显隐、代码视图有复制按钮、echarts 切回图片仍正常。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9255
proc = subprocess.Popen([CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950", "http://localhost:18888/"],
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
    time.sleep(8)

    probe = r"""(async () => {
      const text = '```mermaid\ngraph TD; A-->B;\n```\n\n```echarts\n{"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]}\n```\n';
      const c = document.createElement('div');
      c.className = 'md-content';
      c.innerHTML = renderMd(text);
      enhanceCodeBlocks(c);
      document.body.appendChild(c);
      await renderDiagrams(c);
      await new Promise(r => setTimeout(r, 400));

      const wraps = c.querySelectorAll('.cbh-diagram-wrap');
      const result = { wrapCount: wraps.length, perWrap: [] };
      for (const w of wraps) {
        const tabs = w.querySelectorAll('.cbh-diagram-tab');
        const imgView = w.querySelector('.cbh-diagram-img');
        const codeView = w.querySelector('.cbh-diagram-code');
        const info = {
          tabTexts: Array.from(tabs).map(t => t.textContent),
          hasSvg: !!w.querySelector('.cbh-diagram-img svg'),
          hasCanvas: !!w.querySelector('.cbh-echarts canvas'),
          hasCopyBtn: !!codeView.querySelector('.code-copy-btn'),
          codeText: (codeView.querySelector('code')?.textContent || '').slice(0, 30),
          imgVisibleBefore: imgView.style.display !== 'none',
          codeVisibleBefore: codeView.style.display !== 'none'
        };
        // 点击 "代码" 按钮（第二个）
        tabs[1]?.click();
        info.afterClickCode = { img: imgView.style.display !== 'none', code: codeView.style.display !== 'none',
          tabActive: Array.from(tabs).map(t => t.classList.contains('active')) };
        // 点击 "图片" 按钮（第一个）切回
        tabs[0]?.click();
        info.afterClickImg = { img: imgView.style.display !== 'none', code: codeView.style.display !== 'none',
          canvasStill: !!w.querySelector('.cbh-echarts canvas') };
        result.perWrap.push(info);
      }
      return result;
    })()"""
    r = ev(probe) or {}
    print("图表包装器数量(应2):", r.get("wrapCount"))
    for i, w in enumerate(r.get("perWrap", [])):
        print(f"\n--- 图表 {i+1} ---")
        print("  按钮文本:", w.get("tabTexts"))
        print("  含SVG:", w.get("hasSvg"), "| 含canvas:", w.get("hasCanvas"), "| 代码视图有复制按钮:", w.get("hasCopyBtn"))
        print("  代码视图内容(前30):", repr(w.get("codeText")))
        print("  初始: 图片显示=%s 代码显示=%s" % (w.get("imgVisibleBefore"), w.get("codeVisibleBefore")))
        ac = w.get("afterClickCode", {})
        print("  点[代码]后: 图片=%s 代码=%s active=%s" % (ac.get("img"), ac.get("code"), ac.get("tabActive")))
        ai = w.get("afterClickImg", {})
        print("  点[图片]后: 图片=%s 代码=%s canvas仍在=%s" % (ai.get("img"), ai.get("code"), ai.get("canvasStill")))
finally:
    proc.terminate()

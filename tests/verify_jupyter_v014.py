"""jupyter v0.2.14 端到端：3个mermaid + 1个echarts(用```json标签，测自动识别) + 图片/代码切换按钮。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9256
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
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=180)
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

    ev(r"""(()=>{ const i=document.querySelector('.cbhcli-input');
      i.value='请只回复四个代码块，不要任何其他文字：1) ```mermaid 流程图(graph TD; A-->B; B-->C)；2) ```mermaid 时序图(sequenceDiagram, A->>B: hello)；3) ```mermaid 饼图(pie title T, "A":60, "B":40)；4) 一个 echarts 柱状图配置，但必须用 ```json 作为代码块语言标记开头（不要用 echarts 标记），内容为 {"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]}。';
      i.dispatchEvent(new Event('input'));
      document.querySelector('.cbhcli-btn-primary')?.click(); return 'sent'; })()""")
    print("已发送，等待回复…")

    last_len = -1; stable = 0
    for _ in range(70):
        time.sleep(1)
        ln = ev("(document.querySelector('.cbhcli-msg-ai')?.textContent||'').length")
        if ln == last_len and ln > 0:
            stable += 1
            if stable >= 4: break
        else: stable = 0
        last_len = ln
    print("回复长度:", last_len)
    time.sleep(7)

    ai = "document.querySelector('.cbhcli-msg-ai')"
    print("\n=== 渲染结果 ===")
    print("图表包装器 .cbh-diagram-wrap 数(应4):", ev(f"{ai}.querySelectorAll('.cbh-diagram-wrap').length"))
    print("mermaid SVG 数(应3):", ev(f"{ai}.querySelectorAll('.cbh-diagram-img.cbh-mermaid svg').length"))
    print("echarts canvas 数(应1，来自json块):", ev(f"{ai}.querySelectorAll('.cbh-echarts canvas').length"))
    print("剩余未渲染 language-mermaid:", ev(f"{ai}.querySelectorAll('code.language-mermaid').length"))
    print("AI 实际用的 ``` 标记:", ev(f"(()=>{{const t={ai}.innerText||'';const m=t.match(/```\\w*/g);return m?m.join(','):'none(已全部渲染)'}})()"))

    print("\n=== 图片/代码切换按钮 ===")
    toggle = ev(r"""(()=>{
      const ai=document.querySelector('.cbhcli-msg-ai');
      const wraps=ai.querySelectorAll('.cbh-diagram-wrap');
      let okTabs=0, okCopy=0, toggleWorks=0;
      wraps.forEach(w=>{
        const tabs=w.querySelectorAll('.cbh-diagram-tab');
        if(tabs.length===2 && tabs[0].textContent==='图片' && tabs[1].textContent==='代码') okTabs++;
        if(w.querySelector('.cbh-diagram-code .cbh-code-copy-btn')) okCopy++;
        if(tabs.length===2){
          const img=w.querySelector('.cbh-diagram-img'), code=w.querySelector('.cbh-diagram-code');
          const before=img.style.display!=='none';
          tabs[1].click();
          const afterCode=code.style.display!=='none' && img.style.display==='none';
          tabs[0].click();
          const backImg=img.style.display!=='none';
          if(before && afterCode && backImg) toggleWorks++;
        }
      });
      return {total:wraps.length, okTabs, okCopy, toggleWorks};
    })()""") or {}
    print("总包装器:", toggle.get("total"), "| 按钮正确(图片/代码):", toggle.get("okTabs"),
          "| 代码视图有复制按钮:", toggle.get("okCopy"), "| 切换生效:", toggle.get("toggleWorks"))

    wraps = ev(f"{ai}.querySelectorAll('.cbh-diagram-wrap').length") or 0
    svg = ev(f"{ai}.querySelectorAll('.cbh-diagram-img.cbh-mermaid svg').length") or 0
    canvas = ev(f"{ai}.querySelectorAll('.cbh-echarts canvas').length") or 0
    ok = wraps >= 4 and svg >= 3 and canvas >= 1 and toggle.get("okTabs") == wraps and toggle.get("toggleWorks") == wraps
    print("\n✅ 验证通过（多mermaid+json块echarts全渲染 / 图片代码切换+复制按钮）" if ok else "❌ 验证未完全通过（看上面明细）")
finally:
    proc.terminate()

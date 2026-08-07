"""v0.2.15 前端验证：配置页各分区可折叠 + 知识库分区 + MCP 显示 + 跨进程同步已后端验证。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9257
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
    print("问答面板就绪:", ev("!!document.querySelector('.cbhcli-input')"))

    # 点击「⚙️ 配置」tab
    ev(r"""(()=>{const b=Array.from(document.querySelectorAll('.cbhcli-tab')).find(x=>x.textContent.includes('配置'));if(b){b.click();return 'clicked'}return 'notfound'})()""")
    time.sleep(4)  # 等待各分区异步加载

    print("\n=== 配置页结构 ===")
    print("分区总数 .cbhcli-settings-group:", ev("document.querySelectorAll('.cbhcli-settings-group').length"))
    print("可折叠分区(有chevron):", ev("document.querySelectorAll('.cbhcli-section-chevron').length"))
    print("各分区标题:", ev("Array.from(document.querySelectorAll('.cbhcli-settings-title')).map(t=>t.textContent).join(' | ')"))

    print("\n=== 知识库分区 ===")
    print("知识库状态行存在:", ev("!!document.querySelector('.cbhcli-kb-status')"))
    print("知识库状态文本:", ev("document.querySelector('.cbhcli-kb-status')?.textContent||'none'"))
    print("知识库添加/重建按钮数:", ev("Array.from(document.querySelectorAll('.cbhcli-settings-group')).filter(g=>g.textContent.includes('知识库')).length"))

    print("\n=== MCP 分区 ===")
    print("MCP 服务器卡片显示 web_search:", ev("Array.from(document.querySelectorAll('.cbhcli-mcp-name')).some(n=>n.textContent.includes('web_search'))"))

    print("\n=== 折叠交互测试 ===")
    r = ev(r"""(()=>{
      const groups=Array.from(document.querySelectorAll('.cbhcli-settings-group.collapsible'));
      if(!groups.length) return {err:'no collapsible'};
      const g=groups[0];
      const head=g.querySelector('.cbhcli-section-head');
      const before=g.classList.contains('collapsed');
      head.click();
      const after=g.classList.contains('collapsed');
      const chev=g.querySelector('.cbhcli-section-chevron')?.textContent;
      // 再点一次还原
      head.click();
      const restored=g.classList.contains('collapsed');
      return {before, afterClick:after, chevronAfterClick:chev, restored, title:g.querySelector('.cbhcli-settings-title')?.textContent};
    })()""") or {}
    print("首个可折叠分区:", r.get("title"))
    print("  折叠前=%s → 点击后=%s（chevron=%s）→ 再点还原=%s" % (r.get("before"), r.get("afterClick"), r.get("chevronAfterClick"), r.get("restored")))

    n_groups = ev("document.querySelectorAll('.cbhcli-settings-group').length") or 0
    n_chev = ev("document.querySelectorAll('.cbhcli-section-chevron').length") or 0
    kb = ev("!!document.querySelector('.cbhcli-kb-status')")
    mcp_ws = ev("Array.from(document.querySelectorAll('.cbhcli-mcp-name')).some(n=>n.textContent.includes('web_search'))")
    collapse_ok = (r.get("before") is False and r.get("afterClick") is True and r.get("restored") is False)
    ok = n_groups >= 7 and n_chev >= 7 and kb and mcp_ws and collapse_ok
    print("\n分区数=%s 折叠按钮=%s 知识库=%s MCP=%s 折叠交互=%s" % (n_groups, n_chev, kb, mcp_ws, collapse_ok))
    print("✅ 验证通过" if ok else "❌ 验证未完全通过")
finally:
    proc.terminate()

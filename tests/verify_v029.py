"""v0.2.9 验证：
需求1 工具弹窗新增 Notebook 类别（8 个 nb 工具可勾选启停，真实前端走 XSRF）。
需求2 历史会话显示标题(首条用户消息)+日期，且可折叠/展开。
"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9229
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

    # ============================================================
    # 需求 1：工具弹窗 Notebook 类别
    # ============================================================
    print("=== 需求1：工具弹窗 ===")
    evaluate("Array.from(document.querySelectorAll('.cbhcli-chip-btn')).find(b=>b.textContent.includes('工具'))?.click()")
    time.sleep(3)
    print("弹窗存在:", evaluate("!!document.querySelector('.cbhcli-dialog-wide')"))
    groups = evaluate("Array.from(document.querySelectorAll('.cbhcli-modal-group')).map(g=>g.textContent).join(' | ')")
    print("分组:", groups)
    print("含 Notebook 类别:", "Notebook" in (groups or ""))
    # Notebook 组下的工具名
    nb_names = evaluate("""(() => {
      const gs = Array.from(document.querySelectorAll('.cbhcli-modal-group'));
      const g = gs.find(x => x.textContent.includes('Notebook'));
      if (!g) return [];
      const names = [];
      let n = g.nextElementSibling;
      while (n && !n.classList.contains('cbhcli-modal-group')) {
        const nm = n.querySelector('.cbhcli-check-name');
        if (nm) names.push(nm.textContent);
        n = n.nextElementSibling;
      }
      return names;
    })()""")
    print("Notebook 工具(%d):" % len(nb_names or []), ", ".join(nb_names or []))

    # 勾选启停：找到 nb_delete_cell 的 checkbox，点击禁用 → 验证状态 → 再点恢复
    print("--- 勾选启停 nb_delete_cell ---")
    before = evaluate("""(() => {
      const row = Array.from(document.querySelectorAll('.cbhcli-check-row')).find(r => (r.querySelector('.cbhcli-check-name')||{}).textContent === 'nb_delete_cell');
      return row ? row.querySelector('input').checked : null;
    })()""")
    print("点击前 checked:", before)
    evaluate("""(() => {
      const row = Array.from(document.querySelectorAll('.cbhcli-check-row')).find(r => (r.querySelector('.cbhcli-check-name')||{}).textContent === 'nb_delete_cell');
      const box = row.querySelector('input');
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change'));
    })()""")
    time.sleep(2.5)
    after_state = evaluate("""(() => {
      const row = Array.from(document.querySelectorAll('.cbhcli-check-row')).find(r => (r.querySelector('.cbhcli-check-name')||{}).textContent === 'nb_delete_cell');
      return { checked: row.querySelector('input').checked, label: row.querySelector('.cbhcli-check-state').textContent };
    })()""")
    print("点击后:", after_state)
    # 关闭弹窗，重开验证持久化
    evaluate("document.querySelector('.cbhcli-dialog-close')?.click()")
    time.sleep(1)
    evaluate("Array.from(document.querySelectorAll('.cbhcli-chip-btn')).find(b=>b.textContent.includes('工具'))?.click()")
    time.sleep(3)
    reopen_state = evaluate("""(() => {
      const row = Array.from(document.querySelectorAll('.cbhcli-check-row')).find(r => (r.querySelector('.cbhcli-check-name')||{}).textContent === 'nb_delete_cell');
      return row ? { checked: row.querySelector('input').checked, label: row.querySelector('.cbhcli-check-state').textContent } : null;
    })()""")
    print("重开弹窗后(应持久):", reopen_state)
    # 恢复启用
    evaluate("""(() => {
      const row = Array.from(document.querySelectorAll('.cbhcli-check-row')).find(r => (r.querySelector('.cbhcli-check-name')||{}).textContent === 'nb_delete_cell');
      const box = row.querySelector('input');
      if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
    })()""")
    time.sleep(2)
    evaluate("document.querySelector('.cbhcli-dialog-close')?.click()")
    time.sleep(1)
    print("已恢复启用")

    # ============================================================
    # 需求 2：历史会话标题 + 折叠
    # ============================================================
    print("\n=== 需求2：历史会话 ===")
    # 切到 jupyter agent（有 2 个历史：title='1'/'你好'）
    evaluate("""(() => {
      const sel = document.querySelector('.cbhcli-header-select[title="Agent"]');
      sel.value = 'jupyter';
      sel.dispatchEvent(new Event('change'));
    })()""")
    time.sleep(2)
    # 切到配置 tab
    evaluate("Array.from(document.querySelectorAll('.cbhcli-tab')).find(b=>b.textContent.includes('配置'))?.click()")
    time.sleep(4)
    print("历史标题行:", evaluate("document.querySelector('.cbhcli-history-head')?.textContent"))
    titles = evaluate("Array.from(document.querySelectorAll('.cbhcli-history-title-text')).map(t=>t.textContent)")
    metas = evaluate("Array.from(document.querySelectorAll('.cbhcli-history-meta')).map(t=>t.textContent)")
    print("会话标题:", titles)
    print("会话元信息:", metas)
    print("标题是否为文件名(应 False):", evaluate("Array.from(document.querySelectorAll('.cbhcli-history-title-text')).some(t=>t.textContent.endsWith('.json'))"))
    # 折叠
    print("--- 折叠/展开 ---")
    print("折叠前 list.collapsed:", evaluate("document.querySelector('.cbhcli-history-list')?.classList.contains('collapsed')"))
    evaluate("document.querySelector('.cbhcli-history-head')?.click()")
    time.sleep(1)
    print("点击后 list.collapsed(应 True):", evaluate("document.querySelector('.cbhcli-history-list')?.classList.contains('collapsed')"))
    print("chevron:", evaluate("document.querySelector('.cbhcli-history-chevron')?.textContent"))
    evaluate("document.querySelector('.cbhcli-history-head')?.click()")
    time.sleep(1)
    print("再点展开 list.collapsed(应 False):", evaluate("document.querySelector('.cbhcli-history-list')?.classList.contains('collapsed')"))

finally:
    proc.terminate()

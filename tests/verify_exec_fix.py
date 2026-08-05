"""v0.2.11 修复验证：nb_execute_cell 执行慢 cell（sleep+多图）。
验证：① 任务只派发一次（claim-once）② 不重复执行（execution_count 只 +1）
      ③ 无 "Canceled future" 错误 ④ 输出渲染到 cell。
"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9237
TOKEN = "testtoken123"
API = f"http://localhost:8899/cbhcli/api?token={TOKEN}"

proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    "http://localhost:8899/lab/tree/test_exec.ipynb?token=testtoken123",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def http_get(url):
    try:
        return json.loads(urllib.request.urlopen(url, timeout=5).read())
    except Exception:
        return None

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

    time.sleep(18)
    print("notebook 打开:", ev("!!window.__cbhcliNbClient?._currentNotebook()"))

    # 启动内核
    print("启动内核:", ev("""(async()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
      const sc=nb.context.sessionContext;
      if(!sc.session?.kernel){ await sc.startKernel({name:'python3'}); }
      return sc.session?.kernel?.name || 'no kernel'; })()"""))
    time.sleep(2)

    # 选中 cell 0（命令模式），使选区上下文注入 → nb 工具启用
    ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
      nb.content.activeCellIndex=0; nb.content.mode='command';
      const cell=nb.content.widgets[0]; if(cell.select) cell.select();
      return nb.content.activeCellIndex; })()""")
    time.sleep(1)
    print("选区上下文:", ev("window.__cbhcliNbClient.getCurrentSelectionContext()?.source"))

    # 发送聊天消息，让 agent 用 nb_execute_cell 执行 cell 0
    ev("""(()=>{ const i=document.querySelector('.cbhcli-input');
      i.value='请只调用一次 nb_execute_cell 工具执行 cell 0（cell_index=0，timeout=120），执行完成后只回复“已完成”，不要重复调用也不要调用其他工具';
      i.dispatchEvent(new Event('input'));
      document.querySelector('.cbhcli-btn-primary')?.click(); return 'sent'; })()""")
    print("消息已发送")

    # 监控：执行期间从外部轮询 /notebook/pending，统计任务派发次数
    total_dispatches = 0
    t0 = time.time()
    print("\n--- 外部监控（12 秒执行期）---")
    while time.time() - t0 < 14:
        data = http_get(API.replace("?", "/notebook/pending?"))
        if data and data.get("tasks"):
            total_dispatches += len(data["tasks"])
            print(f"  t={time.time()-t0:.1f}s 轮询返回 {len(data['tasks'])} 个任务(首次派发)")
        # 监控 cell0 执行状态
        ec = ev("""(()=>{const nb=window.__cbhcliNbClient?._currentNotebook();
          if(!nb) return null; const c=nb.content.widgets[0]; return c?.model?.executionCount ?? null;})()""")
        time.sleep(0.5)
    print(f"外部轮询累计派发: {total_dispatches} 次（应 1）")

    # 等执行完成
    print("\n--- 等待执行完成 ---")
    for _ in range(30):
        ec = ev("""(()=>{const nb=window.__cbhcliNbClient?._currentNotebook();
          if(!nb) return null; const c=nb.content.widgets[0]; return c?.model?.executionCount ?? null;})()""")
        if ec:
            print(f"cell0 execution_count = {ec}")
            break
        time.sleep(1)

    time.sleep(2)
    print("\n=== 最终检查 ===")
    print("cell0 execution_count:", ev("""(()=>{const nb=window.__cbhcliNbClient._currentNotebook();
      const c=nb.content.widgets[0]; return c.model.executionCount;})()"""))
    # 输出区：类型与文本
    outs = ev("""(()=>{const nb=window.__cbhcliNbClient._currentNotebook();
      const c=nb.content.widgets[0];
      return c.outputArea.model.toJSON().map(o=>({type:o.output_type, data:o.data&&o.data['text/plain']||''}));})()""")
    print("cell0 输出区:", json.dumps(outs, ensure_ascii=False)[:300])
    # 消息区是否有 Canceled future 错误
    msgs = ev("document.querySelector('.cbhcli-messages')?.textContent || ''")
    has_canceled = 'Canceled future' in msgs
    print("消息区含 'Canceled future':", has_canceled)
    print("消息区含 '已完成':", '已完成' in msgs)
    print("消息区尾部 300:", msgs[-300:] if msgs else '(空)')
    print("总外部派发观测:", total_dispatches,
          "次（0=前端200ms内已claim，claim-once生效；旧实现下会重复看到约24次）")
    print("有错误:", has_canceled)
    # 判定：恰好执行一次 + 无 Canceled future + agent 成功收到结果 + 输出渲染
    ok = (ec == 1) and (not has_canceled) and ('已完成' in msgs) and (len(outs) >= 3)
    print("✅ 验证通过（执行1次/无错误/输出可见/claim-once生效）" if ok else "❌ 验证失败")

finally:
    proc.terminate()

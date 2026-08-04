"""验证问题2(edit精确)/3(空cell选区)/4(执行输出渲染)。"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9235
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    "http://localhost:8899/lab/tree/test_nb.ipynb?token=testtoken123",
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
        mid[0]+=1; ws.send(json.dumps({"id":mid[0],"method":m,"params":p or {}}))
        while True:
            r=json.loads(ws.recv())
            if r.get("id")==mid[0]: return r.get("result",{})
    def ev(x, await_p=True):
        return cdp("Runtime.evaluate",{"expression":x,"returnByValue":True,"awaitPromise":await_p}).get("result",{}).get("value")

    time.sleep(18)
    print("notebook 打开:", ev("!!window.__cbhcliNbClient?._currentNotebook()"))
    print("cell 数:", ev("window.__cbhcliNbClient?._currentNotebook()?.content?.model?.cells?.length"))

    # 确保内核启动
    print("\n=== 启动内核 ===")
    print(ev("""(async()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
      const sc=nb.context.sessionContext;
      if(!sc.session?.kernel){ await sc.startKernel({name:'python3'}); }
      return sc.session?.kernel?.name || 'no kernel'; })()"""))
    time.sleep(3)

    # ===== 问题4: 执行 cell1 (print hello)，输出应渲染到 cell =====
    print("\n===== 问题4: 执行输出渲染 =====")
    print("执行结果:", ev("""(async()=>{ const c=window.__cbhcliNbClient;
      return await c._executeCell({cell_index:1}); })()"""))
    time.sleep(1)
    print("cell1 输出区内容:", ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
      const cell=nb.content.widgets[1];
      return cell.outputArea.model.toJSON(); })()"""))

    # ===== 问题3: 空 cell 选中识别 =====
    print("\n===== 问题3: 空cell选区识别 =====")
    print(ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
      nb.content.activeCellIndex=2;
      // 命令模式选中该 cell
      nb.content.mode='command';
      const cell=nb.content.widgets[2];
      if(cell.select) cell.select();
      return {mode:nb.content.mode, isSelected:cell.isSelected}; })()"""))
    time.sleep(1)
    print("getCurrentSelectionContext:", ev("window.__cbhcliNbClient.getCurrentSelectionContext()"))

    # ===== 问题2: edit 精确匹配（111111 选后两个1） =====
    print("\n===== 问题2: edit 精确匹配 =====")
    # 在 cell0 设置选区为最后两个 1（"x = 111111" 中列8-10）
    print("设置选区:", ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
      nb.content.activeCellIndex=0;
      const cell=nb.content.widgets[0];
      const ed=cell.editor; // CodeMirrorEditor
      ed.setSelection({start:{line:0,column:8}, end:{line:0,column:10}});
      return ed.getSelection(); })()"""))
    print("cell0 原文:", ev("window.__cbhcliNbClient._currentNotebook().content.model.cells.get(0).sharedModel.getSource()"))
    print("edit 结果:", ev("""(async()=>{ const c=window.__cbhcliNbClient;
      return await c._editCell({cell_index:0, selection_text:'11', new_code:'99'}); })()"""))
    print("cell0 改后(应为 x = 111199):", ev("window.__cbhcliNbClient._currentNotebook().content.model.cells.get(0).sharedModel.getSource()"))

finally:
    proc.terminate()

"""v0.2.9 修复验证：cell_type 参数生效（新增 markdown / code→markdown / markdown→code）。
直连 window.__cbhcliNbClient 的 _insertCell/_editCell（运行时可访问私有方法）。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9236
proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    "http://localhost:8899/lab/tree/test_nb.ipynb?token=testtoken123",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def cell_types():
    return ev("(()=>{const nb=window.__cbhcliNbClient._currentNotebook();"
              "return Array.from({length:nb.content.model.cells.length},"
              "(_,i)=>nb.content.model.cells.get(i).type);})()")

def cell_src(i):
    return ev(f"window.__cbhcliNbClient._currentNotebook().content.model.cells.get({i}).sharedModel.getSource()")

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
    print("初始 cell 类型:", cell_types())

    # ===== A. 新增 markdown cell =====
    print("\n===== A. nb_insert_cell cell_type=markdown =====")
    r = ev("(async()=>{const c=window.__cbhcliNbClient;"
           "return await c._insertCell({code:'# 这是新增的 markdown', cell_type:'markdown', cell_index:3});})()")
    print("insert 返回:", r)
    time.sleep(1)
    print("insert 后类型(末尾应 markdown):", cell_types())
    print("新 cell 内容:", cell_src(3))

    # ===== B. code → markdown =====
    print("\n===== B. nb_edit_cell cell_type=markdown (cell0 code→markdown) =====")
    print("cell0 原类型:", ev("window.__cbhcliNbClient._currentNotebook().content.model.cells.get(0).type"))
    r = ev("(async()=>{const c=window.__cbhcliNbClient;"
           "return await c._editCell({cell_index:0, new_code:'# 标题：转成 markdown', cell_type:'markdown'});})()")
    print("edit 返回:", r)
    time.sleep(1)
    print("cell0 现类型(应 markdown):", ev("window.__cbhcliNbClient._currentNotebook().content.model.cells.get(0).type"))
    print("cell0 内容(应保留):", cell_src(0))
    print("全部类型:", cell_types())

    # ===== C. markdown → code（转回） =====
    print("\n===== C. nb_edit_cell cell_type=code (cell0 markdown→code) =====")
    r = ev("(async()=>{const c=window.__cbhcliNbClient;"
           "return await c._editCell({cell_index:0, new_code:'x = 111111', cell_type:'code'});})()")
    print("edit 返回:", r)
    time.sleep(1)
    print("cell0 现类型(应 code):", ev("window.__cbhcliNbClient._currentNotebook().content.model.cells.get(0).type"))
    print("cell0 内容:", cell_src(0))
    print("最终全部类型:", cell_types())

    # ===== D. 默认 code（不传 cell_type 插入应为 code） =====
    print("\n===== D. nb_insert_cell 不传 cell_type（默认 code） =====")
    r = ev("(async()=>{const c=window.__cbhcliNbClient;"
           "return await c._insertCell({code:'z = 99', cell_index:4});})()")
    print("insert 返回:", r)
    time.sleep(1)
    print("最终全部类型:", cell_types())

finally:
    proc.terminate()

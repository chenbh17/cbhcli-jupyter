"""v0.3.1 CDP 验证：分区默认收起 + Alt+Enter 换行 + 默认 agent + 模型编辑回显。"""
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
        return cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                        "awaitPromise": True}).get("result", {}).get("value")

    time.sleep(20)

    print("=== 0. 面板加载 ===")
    print("cbhcli 面板存在:", evaluate("!!document.querySelector('.cbhcli-panel')"))

    print("\n=== 1. 默认 Agent（问题3：应为 active_agent=jupyter，不是 main）===")
    print("agent 下拉当前值:", evaluate("document.querySelector('.cbhcli-header-select')?.value"))

    print("\n=== 2. 配置页分区默认收起（问题2）===")
    evaluate("Array.from(document.querySelectorAll('.cbhcli-tab')).find(t=>t.textContent.includes('配置'))?.click()")
    time.sleep(4)
    n_all = evaluate("document.querySelectorAll('.cbhcli-settings-group.collapsible').length")
    n_collapsed = evaluate("document.querySelectorAll('.cbhcli-settings-group.collapsible.collapsed').length")
    print(f"可折叠分区: {n_collapsed}/{n_all} 收起（应全部收起）")
    print("分区标题:", evaluate(
        "Array.from(document.querySelectorAll('.cbhcli-settings-title')).map(t=>t.textContent).join(' | ')"))

    print("\n=== 3. 点击展开 + 状态保持 ===")
    evaluate("document.querySelector('.cbhcli-section-head')?.click()")
    time.sleep(1)
    print("点击后第一个分区展开:", evaluate(
        "!document.querySelector('.cbhcli-settings-group.collapsible').classList.contains('collapsed')"))
    # 切回问答再切回配置（触发 refresh 重建），展开状态应保持
    evaluate("Array.from(document.querySelectorAll('.cbhcli-tab')).find(t=>t.textContent.includes('问答'))?.click()")
    time.sleep(1)
    evaluate("Array.from(document.querySelectorAll('.cbhcli-tab')).find(t=>t.textContent.includes('配置'))?.click()")
    time.sleep(4)
    print("refresh 后第一个分区仍展开:", evaluate(
        "!document.querySelector('.cbhcli-settings-group.collapsible').classList.contains('collapsed')"))
    print("refresh 后其余分区仍收起:", evaluate(
        "document.querySelectorAll('.cbhcli-settings-group.collapsible.collapsed').length"))

    print("\n=== 4. 模型编辑回显（问题1：Base URL 字段应有值）===")
    evaluate("Array.from(document.querySelectorAll('.cbhcli-btn')).find(b=>b.textContent.trim()==='编辑')?.click()")
    time.sleep(2)
    print("编辑弹窗存在:", evaluate("!!document.querySelector('.cbhcli-dialog')"))
    print("Base URL 输入框值:", evaluate(
        "Array.from(document.querySelectorAll('.cbhcli-dialog .cbhcli-input')).find(i=>i.placeholder.includes('deepseek'))?.value?.slice(0,50) || Array.from(document.querySelectorAll('.cbhcli-dialog .cbhcli-input'))[2]?.value?.slice(0,50)"))
    print("表单各字段值:", evaluate(
        "Array.from(document.querySelectorAll('.cbhcli-dialog .cbhcli-input')).map(i=>i.dataset.key+'='+String(i.value?'(有值)':'(空)')).join(', ')"))
    evaluate("Array.from(document.querySelectorAll('.cbhcli-dialog button')).find(b=>b.textContent==='取消')?.click()")
    time.sleep(1)

    print("\n=== 5. Alt+Enter 换行（问题5）===")
    # 注意：CDP 连续 evaluate 共享顶层词法作用域，必须用 IIFE 避免 const 冲突
    evaluate("Array.from(document.querySelectorAll('.cbhcli-tab')).find(t=>t.textContent.includes('问答'))?.click()")
    time.sleep(1)
    evaluate("""
        (() => {
            const ta = document.querySelector('.cbhcli-input');
            ta.value = '第一行';
            ta.focus();
            ta.selectionStart = ta.selectionEnd = ta.value.length;
            ta.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', altKey:true, bubbles:true, cancelable:true}));
        })()
    """)
    time.sleep(1)
    val = evaluate("document.querySelector('.cbhcli-input').value")
    print("Alt+Enter 后输入框内容:", repr(val))
    print("包含换行:", "\n" in (val or ""))
    print("未发送（无用户消息气泡新增）:", evaluate(
        "document.querySelectorAll('.cbhcli-msg-user').length"))
    # Enter（无修饰键）应发送
    r = evaluate("""
        (() => {
            const ta = document.querySelector('.cbhcli-input');
            ta.focus();
            const ev = new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true});
            ta.dispatchEvent(ev);
            return {
                prevented: ev.defaultPrevented,
                value: ta.value,
                sendDisabled: document.querySelector('.cbhcli-btn-primary').disabled,
                inputDisabled: ta.disabled
            };
        })()
    """)
    print("Enter 探测:", r)
    time.sleep(3)
    print("Enter 后消息已发送（输入框清空）:", evaluate("document.querySelector('.cbhcli-input').value === ''"))

finally:
    proc.terminate()

"""v0.3.2 验证：
① nb_execute_cell 执行时 cell 左侧显示 In [ * ]: 运行指示（完成后 [N]:）
② 工具运行中点「停止」-> 立即中断（nb 工具被 cancel_all 唤醒，UI 数秒内解除忙碌）
③ 停止后再发消息正常回复，不报 "❌ 连接错误: signal is aborted without reason"
"""
import json, time, urllib.request, subprocess, sys
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9237
BASE = "http://localhost:8899"
TOKEN = "testtoken123"
NB = "test_v032.ipynb"

# ---- 创建全新测试 notebook（避免旧 cell 干扰）----
nb_content = {
    "type": "notebook",
    "content": {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3"}},
        "cells": [
            {"cell_type": "code", "id": "c0", "metadata": {}, "execution_count": None,
             "outputs": [], "source": "print('init')"},
        ],
    },
}
req = urllib.request.Request(
    f"{BASE}/api/contents/{NB}?token={TOKEN}",
    data=json.dumps(nb_content).encode(), method="PUT",
    headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=15).read()
print("测试 notebook 已创建")

proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*", f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    f"{BASE}/lab/tree/{NB}?token={TOKEN}",
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
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=180)
    mid = [0]

    def cdp(m, p=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == mid[0]:
                return r.get("result", {})

    def ev(x, await_p=True):
        res = cdp("Runtime.evaluate", {"expression": x, "returnByValue": True, "awaitPromise": await_p})
        return res.get("result", {}).get("value")

    time.sleep(15)
    print("nbClient 就绪:", ev("!!window.__cbhcliNbClient?._currentNotebook()"))
    # 确保内核
    print("内核:", ev("""(async()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
        const sc=nb.context.sessionContext;
        if(!sc.session?.kernel){ await sc.startKernel({name:'python3'}); }
        return sc.session?.kernel?.name || 'no kernel'; })()"""))
    time.sleep(2)

    def prompt0():
        return ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
            return nb.content.widgets[0].node.querySelector('.jp-InputPrompt')?.textContent||''; })()""")

    # ============== Part A: [*] 运行指示 ==============
    print("\n===== Part A: [*] 运行指示 =====")
    ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
        nb.content.model.cells.get(0).sharedModel.setSource("import time\\ntime.sleep(6)\\nprint('done')");
        return true; })()""")
    ev("""(()=>{ window.__execA=null; window.__cbhcliNbClient
        ._executeCell({cell_index:0}).then(r=>{window.__execA=r;}); return 'started'; })()""")
    time.sleep(2.5)  # 执行中
    mid_prompt = prompt0()
    print("执行中提示符:", repr(mid_prompt), "-> 判定 [*]:", "[*]" in mid_prompt)
    for _ in range(40):
        if ev("!!window.__execA"):
            break
        time.sleep(1)
    print("执行结果:", json.dumps(ev("window.__execA"), ensure_ascii=False)[:200])
    end_prompt = prompt0()
    ok_a = "[*]" in mid_prompt and "[*]" not in end_prompt and "[" in end_prompt
    print("完成提示符:", repr(end_prompt), "-> 判定 [N]:", ("[*]" not in end_prompt and "[6]" not in end_prompt and end_prompt.strip().startswith("[")))
    print("Part A 结论:", "✅ 通过" if ("[*]" in mid_prompt and "[*]" not in end_prompt) else "❌ 失败")

    # ============== Part B: 停止 e2e ==============
    print("\n===== Part B: 停止中断 e2e =====")
    # cell0 换成长任务
    ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
        nb.content.model.cells.get(0).sharedModel.setSource("import time\\ntime.sleep(300)\\nprint('long done')");
        return true; })()""")
    # 命令模式选中 cell0 -> 选区注入 -> nb 工具启用
    ev("""(()=>{ const nb=window.__cbhcliNbClient._currentNotebook();
        nb.content.activeCellIndex=0; nb.content.mode='command';
        try{ nb.content.select(nb.content.widgets[0]); }catch(e){}
        return true; })()""")
    time.sleep(2)

    # 发消息（textarea 填值 + 点发送按钮）
    sent = ev("""(()=>{ const ta=document.querySelector('#cbhcli-jupyter-panel textarea.cbhcli-input');
        if(!ta) return 'no-input';
        ta.value='请立即用 nb_execute_cell 工具执行第一个 cell（cell_index=0），不要修改内容，执行完把输出告诉我。';
        document.querySelector('#cbhcli-jupyter-panel .cbhcli-btn-primary').click();
        return 'sent'; })()""")
    print("发送:", sent)

    # 等待 AI 调工具：cell0 出现 [*]（最长 120s）
    t_start = time.time()
    running = False
    while time.time() - t_start < 120:
        p = prompt0()
        if "[*]" in p:
            running = True
            break
        time.sleep(1)
    print("工具执行中(cell[*]):", running, f"等待 {time.time()-t_start:.0f}s")
    if not running:
        print("❌ AI 未调用 nb_execute_cell，终止 Part B")
        sys.exit(1)

    # 点停止，计时到 UI 解除忙碌
    t_stop = time.time()
    ev("document.querySelector('#cbhcli-jupyter-panel .cbhcli-btn-stop').click()")
    unblocked = None
    while time.time() - t_stop < 30:
        if ev("""(()=>{ const ta=document.querySelector('#cbhcli-jupyter-panel textarea.cbhcli-input');
            return ta && !ta.disabled; })()"""):
            unblocked = time.time() - t_stop
            break
        time.sleep(0.5)
    print("停止 -> UI 解除忙碌耗时:", f"{unblocked:.1f}s" if unblocked else ">30s(超时)")

    msgs = ev("""(()=>{ const el=document.querySelector('#cbhcli-jupyter-panel .cbhcli-messages');
        return el? el.innerText : ''; })()""")
    print("含'已中断':", "已中断" in msgs)
    print("含'❌ 连接错误':", "❌ 连接错误" in msgs)
    ok_b = unblocked is not None and unblocked < 10 and "已中断" in msgs and "❌ 连接错误" not in msgs
    print("Part B 结论:", "✅ 通过" if ok_b else "❌ 失败")

    # ============== Part C: 停止后新消息正常回复 ==============
    print("\n===== Part C: 停止后新消息 =====")
    ev("""(()=>{ const ta=document.querySelector('#cbhcli-jupyter-panel textarea.cbhcli-input');
        ta.value='1+1等于几？只回答阿拉伯数字。';
        document.querySelector('#cbhcli-jupyter-panel .cbhcli-btn-primary').click();
        return 'sent'; })()""")
    t_c = time.time()
    reply_ok = False
    while time.time() - t_c < 90:
        done = ev("""(()=>{ const el=document.querySelector('#cbhcli-jupyter-panel .cbhcli-messages');
            return el? !el.querySelector('textarea') : false; })()""")
        busy = ev("""(()=>{ const ta=document.querySelector('#cbhcli-jupyter-panel textarea.cbhcli-input');
            return ta && !ta.disabled; })()""")
        if busy and time.time() - t_c > 5:
            # 已解除忙碌 = 回复完成
            reply_ok = True
            break
        time.sleep(1)
    time.sleep(1)
    msgs = ev("""(()=>{ const el=document.querySelector('#cbhcli-jupyter-panel .cbhcli-messages');
        return el? el.innerText.slice(-300) : ''; })()""")
    print("对话尾部:", repr(msgs[-160:]))
    err_count = msgs.count("❌ 连接错误")
    print("Part C 结论:", "✅ 通过" if (reply_ok and err_count == 0) else f"❌ 失败(err_count={err_count})")

    print("\n========== 总结 ==========")
    print(f"A([*]指示): {'✅' if '[*]' in mid_prompt and '[*]' not in end_prompt else '❌'}")
    print(f"B(停止): {'✅' if ok_b else '❌'}")
    print(f"C(停止后正常): {'✅' if reply_ok and err_count == 0 else '❌'}")
finally:
    proc.terminate()
    try:
        proc.wait(5)
    except Exception:
        proc.kill()

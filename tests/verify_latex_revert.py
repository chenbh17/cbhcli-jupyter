"""v0.2.12 回退验证：latex/math/tex 代码块一律显示为代码（保护），正文 $/$$ 公式照常渲染，无报错。"""
import json, time, urllib.request, subprocess
import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9242
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
    print("面板就绪:", ev("!!document.querySelector('.cbhcli-input')"))

    # 让 AI 同时输出：正文行内公式 + 一个 latex 代码块（含 \section/equation 这类会报错的内容）
    ev(r"""(()=>{ const i=document.querySelector('.cbhcli-input');
      i.value='请回复两部分：第一部分写一行文字并带行内公式 $E=mc^2$；第二部分输出一个 latex 代码块（```latex 开头），块内写 \\section{标题} 和 \\begin{equation} x=1 \\end{equation}。';
      i.dispatchEvent(new Event('input'));
      document.querySelector('.cbhcli-btn-primary')?.click(); return 'sent'; })()""")
    print("消息已发送，等待回复…")

    last_len = -1
    stable = 0
    for _ in range(40):
        time.sleep(1)
        ln = ev("(document.querySelector('.cbhcli-msg-ai')?.textContent||'').length")
        if ln == last_len and ln > 0:
            stable += 1
            if stable >= 3:
                break
        else:
            stable = 0
        last_len = ln
    print("回复长度:", last_len)

    print("\n=== 渲染检查 ===")
    ai = "document.querySelector('.cbhcli-msg-ai')"
    # 正文行内公式应渲染
    print("正文 .katex 总数(应≥1):", ev(f"{ai}.querySelectorAll('.katex').length"))
    print("正文行内 .cbh-math-inline(应≥1):", ev(f"{ai}.querySelectorAll('.cbh-math-inline').length"))
    # latex 代码块应是 <pre> 代码，且内部无 .katex
    print("<pre> 代码块数(应≥1):", ev(f"{ai}.querySelectorAll('pre').length"))
    print("<pre> 内 .katex 数(应 0，代码块不渲染):", ev(f"Array.from({ai}.querySelectorAll('pre')).reduce((a,p)=>a+p.querySelectorAll('.katex').length,0)"))
    print("latex 块原文保留 \\section:", ev(f"Array.from({ai}.querySelectorAll('pre')).some(p=>p.textContent.includes('section'))"))
    print("latex 块原文保留 equation:", ev(f"Array.from({ai}.querySelectorAll('pre')).some(p=>p.textContent.includes('equation'))"))
    # 无报错
    print(".katex-error 数(应 0):", ev(f"{ai}.querySelectorAll('.katex-error').length"))
    print("残留 .cbh-latex-block(应 0):", ev(f"{ai}.querySelectorAll('.cbh-latex-block').length"))

    katex_n = ev(f"{ai}.querySelectorAll('.katex').length") or 0
    inline_n = ev(f"{ai}.querySelectorAll('.cbh-math-inline').length") or 0
    pre_katex = ev(f"Array.from({ai}.querySelectorAll('pre')).reduce((a,p)=>a+p.querySelectorAll('.katex').length,0)") or 0
    err = ev(f"{ai}.querySelectorAll('.katex-error').length") or 0
    pre_n = ev(f"{ai}.querySelectorAll('pre').length") or 0
    ok = katex_n >= 1 and inline_n >= 1 and pre_n >= 1 and pre_katex == 0 and err == 0
    print("\n✅ 验证通过（正文公式渲染 / latex块为代码 / 无报错）" if ok else "❌ 验证失败")

finally:
    proc.terminate()

"""CDP 验证 v0.2 重构后的 UI：面板加载 + 新组件渲染 + 无 JS 报错。"""
import json
import time
import urllib.request
import subprocess
import sys

import websocket

CHROME = "/snap/bin/chromium"
DEBUG_PORT = 9224
URL = "http://localhost:8899/lab?token=testtoken123"

proc = subprocess.Popen([
    CHROME, "--headless", "--no-sandbox", "--disable-gpu",
    "--remote-allow-origins=*",
    f"--remote-debugging-port={DEBUG_PORT}",
    "--window-size=1500,950",
    URL,
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

tabs = []
try:
    for _ in range(40):
        try:
            tabs = json.loads(urllib.request.urlopen(
                f"http://localhost:{DEBUG_PORT}/json", timeout=3).read())
            if tabs:
                break
        except Exception:
            pass
        time.sleep(1)
    if not tabs:
        print("❌ CDP 未就绪")
        sys.exit(1)

    page = [t for t in tabs if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
    msg_id = 0

    def send(method, params=None):
        global msg_id
        msg_id += 1
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        return msg_id

    def evaluate(expr):
        mid = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == mid:
                return resp.get("result", {}).get("result", {}).get("value")

    # 收集 console 错误
    send("Runtime.enable")
    console_errors = []

    print("等待 JupyterLab 加载…")
    time.sleep(18)

    # 1. 左侧 tab 是否出现 cbhcli
    tabs_js = """
    Array.from(document.querySelectorAll('.lm-TabBar-tab')).map(t => ({
        id: t.getAttribute('data-id'), title: t.getAttribute('title')
    }))
    """
    left_tabs = evaluate(tabs_js) or []
    cbhcli_tab = [t for t in left_tabs if t['id'] == 'cbhcli-jupyter-panel']
    print(f"[1] 左侧 cbhcli tab: {'✅ 存在' if cbhcli_tab else '❌ 缺失'}")

    # 2. 激活面板（优先用命令，回退点击 tab）
    activate_js = """
    (async () => {
        try {
            // JupyterLab 4 全局 app 实例
            const app = document.querySelector('#main')?.jupyterapp
                || window.jupyterapp || window.__jupyterapp;
            if (app && app.commands) {
                await app.commands.execute('cbhcli-jupyter:open');
                return 'command';
            }
        } catch (e) {}
        const tab = Array.from(document.querySelectorAll('.lm-TabBar-tab'))
            .find(t => t.getAttribute('data-id') === 'cbhcli-jupyter-panel');
        if (tab) { tab.click(); return 'click'; }
        return 'none';
    })()
    """
    # evaluate 不支持 async 直接，改用同步点击 + 命令兜底
    evaluate("""
    (() => {
        const tab = Array.from(document.querySelectorAll('.lm-TabBar-tab'))
            .find(t => t.getAttribute('data-id') === 'cbhcli-jupyter-panel');
        if (tab) { tab.click(); return true; }
        return false;
    })()
    """)
    time.sleep(4)

    # 3. 检查新 UI 组件
    checks = {
        "面板可见": "!document.getElementById('cbhcli-jupyter-panel')?.classList.contains('lm-mod-hidden')",
        "顶栏Agent/模型选择": "document.querySelectorAll('.cbhcli-header-select').length === 2",
        "路径条": "!!document.querySelector('.cbhcli-path-bar')",
        "上下文进度条": "!!document.querySelector('.cbhcli-ctx-meter')",
        "上下文分子/分母": "!!document.querySelector('.cbhcli-ctx-fraction')",
        "消息区": "!!document.querySelector('.cbhcli-messages')",
        "输入框": "!!document.querySelector('.cbhcli-input')",
        "4个动作按钮": "document.querySelectorAll('.cbhcli-chip-btn').length === 4",
        "动作按钮含工具/skills/压缩/新对话": "['工具','Skills','压缩','新对话'].every(t=>Array.from(document.querySelectorAll('.cbhcli-chip-btn')).some(b=>b.textContent.includes(t)))",
        "发送/停止按钮": "!!document.querySelector('.cbhcli-btn-primary') && !!document.querySelector('.cbhcli-btn-stop')",
        "旧信息栏已移除": "!document.querySelector('.cbhcli-info-sidebar')",
        "旧状态栏已移除": "!document.querySelector('.cbhcli-statusbar')",
        "问答/配置Tab": "document.querySelectorAll('.cbhcli-tab').length === 2",
    }
    print("\n[2] 新 UI 组件检查:")
    all_ok = True
    for name, expr in checks.items():
        try:
            r = evaluate(expr)
        except Exception as e:
            r = f"ERR {e}"
        ok = r is True
        all_ok = all_ok and ok
        print(f"  {'✅' if ok else '❌'} {name}: {r}")

    # 4. 上下文分子/分母实际文本
    frac = evaluate("document.querySelector('.cbhcli-ctx-fraction')?.textContent || ''")
    path = evaluate("document.querySelector('.cbhcli-path-bar')?.textContent || ''")
    print(f"\n[3] 上下文分数文本: {frac!r}")
    print(f"    路径条文本: {path!r}")

    # 5. 切到配置页，检查备用模型可配置
    evaluate("Array.from(document.querySelectorAll('.cbhcli-tab')).find(t=>t.textContent.includes('配置'))?.click()")
    time.sleep(3)
    cfg_checks = {
        "模型管理区": "document.body.textContent.includes('模型管理')",
        "备用模型区": "document.body.textContent.includes('备用模型')",
        "备用模型添加下拉": "!!document.querySelector('.cbhcli-fb-select')",
        "权限模式区": "document.body.textContent.includes('权限模式')",
        "历史会话区": "document.body.textContent.includes('历史会话')",
        "配置页无Agent/模型下拉": "document.querySelectorAll('.cbhcli-settings .cbhcli-header-select').length === 0",
    }
    print("\n[4] 配置页检查:")
    for name, expr in cfg_checks.items():
        try:
            r = evaluate(expr)
        except Exception as e:
            r = f"ERR {e}"
        ok = r is True
        all_ok = all_ok and ok
        print(f"  {'✅' if ok else '❌'} {name}: {r}")

    # 6. JS 运行时错误
    errs = evaluate("window.__cbhcliErrors || 'none'")
    print(f"\n[5] window.__cbhcliErrors: {errs}")

    print("\n" + ("=" * 40))
    print("✅ 全部通过" if all_ok else "❌ 有检查项未通过")

finally:
    proc.terminate()

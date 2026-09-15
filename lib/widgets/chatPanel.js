/**
 * cbhcli 主面板（v0.2 重构）。
 *
 * 布局：
 *   顶栏（Agent/模型，唯一显示位置）→ Tab（问答/配置）
 *   问答视图：路径条（跟随文件浏览器）+ 上下文用量（分子/分母）+ 选区小眼睛
 *             → 消息流（用户→思考→工具→输出 依次出现，仿 cbhcli Web 块指针模式）
 *             → 输入框 + 4 个动作按钮（工具/Skills/压缩/新对话）+ 停止/发送
 *
 * 中断只通过「停止」按钮，不监听任何全局键盘快捷键。
 */
import { Widget } from '@lumino/widgets';
import { apiGet, apiPost, apiPut, streamChat } from '../api';
import { SettingsPanel } from './settingsPanel';
import { NotebookClient } from '../notebook/nbClient';
import { renderMarkdown, enhanceCodeBlocks, renderToolArgs, renderToolResult, stripAnsi, normalizeTodos, todoPanelEl, renderDiagrams } from './render';
// ---------------------------------------------------------------------------
//  工具函数
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'class') {
            node.className = v;
        }
        else if (k === 'text') {
            node.textContent = v;
        }
        else if (k.startsWith('on') && typeof v === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), v);
        }
        else if (k === 'checked' || k === 'disabled') {
            if (v) {
                node.setAttribute(k, '');
            }
        }
        else if (v !== null && v !== undefined) {
            node.setAttribute(k, String(v));
        }
    }
    for (const c of children) {
        if (c === null || c === undefined) {
            continue;
        }
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}
/** 数字紧凑格式（1.2k / 3.4M）。 */
function fmtNum(n) {
    if (!n && n !== 0) {
        return '0';
    }
    if (n >= 1e6) {
        return (n / 1e6).toFixed(1) + 'M';
    }
    if (n >= 1e3) {
        return (n / 1e3).toFixed(1) + 'k';
    }
    return String(n);
}
// ---------------------------------------------------------------------------
//  主面板
// ---------------------------------------------------------------------------
export class CbhcliPanel extends Widget {
    constructor(app, notebookTracker, fileBrowserFactory) {
        super();
        this._selectionCtx = null;
        this._selectionEnabled = true;
        this._selPollTimer = null;
        this._lastSelKey = '';
        // 路径跟踪
        this._serverRoot = '';
        this._currentRelPath = '';
        this._pathSlot = null;
        this._boundBrowserModel = null;
        // 会话状态
        // v0.3.1：初始 Agent 在 _initChoices 中从后端 active_agent 恢复（与 CLI/Web 一致），
        // 不再写死 main；_agentInited 防止后续 refresh 覆盖用户当前选择
        this._agentName = 'main';
        this._agentInited = false;
        this._modelName = '';
        this._busy = false;
        this._abortFn = null;
        this.addClass('cbhcli-panel');
        this._fbFactory = fileBrowserFactory;
        this._settings = new SettingsPanel({
            getAgent: () => this._agentName,
            getModel: () => this._modelName,
            notify: () => {
                this._messagesEl.innerHTML = '';
                this._refreshStatus();
                void this._initChoices(false);
            }
        });
        this._nbClient = new NotebookClient(app, notebookTracker);
        this._nbClient.start();
        // 诊断/测试钩子（CDP 验证 notebook 功能）
        window.__cbhcliNbClient = this._nbClient;
        this.node.appendChild(this._build());
        void this._initChoices(true);
        this._setupPathTracking();
        this._startSelectionPoll();
    }
    dispose() {
        this._nbClient.stop();
        if (this._selPollTimer !== null) {
            window.clearInterval(this._selPollTimer);
            this._selPollTimer = null;
        }
        this._unbindBrowserPath();
        if (this._abortFn) {
            this._abortFn();
        }
        super.dispose();
    }
    // ------------------------------------------------------------------
    //  构建 UI
    // ------------------------------------------------------------------
    _build() {
        const root = el('div', { class: 'cbhcli-root' });
        // 顶栏：logo + 标题 + Agent + 模型（唯一显示位置）
        const header = el('div', { class: 'cbhcli-header' });
        // 品牌图标：与 cbhcli Web 浏览器图标（favicon.svg）一致的蓝色箭头
        const logo = el('div', { class: 'cbhcli-logo' });
        logo.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="18" height="18">' +
                '<rect width="48" height="48" rx="11" fill="#11151d"/>' +
                '<rect x="0.5" y="0.5" width="47" height="47" rx="10.5" fill="none" stroke="#2a3240"/>' +
                '<path d="M16 11 L34 24 L16 37" fill="none" stroke="#4f8cff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>';
        header.appendChild(logo);
        header.appendChild(el('div', { class: 'cbhcli-header-title' }, 'cbhcli'));
        this._agentSelect = el('select', {
            class: 'cbhcli-select cbhcli-header-select',
            title: 'Agent',
            onchange: () => this._onAgentChange()
        });
        this._modelSelect = el('select', {
            class: 'cbhcli-select cbhcli-header-select',
            title: '模型',
            onchange: () => this._onModelChange()
        });
        header.appendChild(this._agentSelect);
        header.appendChild(this._modelSelect);
        root.appendChild(header);
        // Tab
        const tabBar = el('div', { class: 'cbhcli-tabs' });
        const tabChat = el('button', { class: 'cbhcli-tab active', text: '💬 问答' });
        const tabSettings = el('button', { class: 'cbhcli-tab', text: '⚙️ 配置' });
        tabBar.appendChild(tabChat);
        tabBar.appendChild(tabSettings);
        root.appendChild(tabBar);
        // 问答视图
        const chatView = el('div', { class: 'cbhcli-chat-view' });
        // v0.3.3：后端加载失败横幅（默认隐藏；cbhcli 未安装/版本不兼容时显示）
        this._backendErrorEl = el('div', { class: 'cbhcli-backend-error cbhcli-hidden' });
        chatView.appendChild(this._backendErrorEl);
        // 状态条：路径 + 上下文用量 + 小眼睛
        const statusStrip = el('div', { class: 'cbhcli-status-strip' });
        this._pathEl = el('div', { class: 'cbhcli-path-bar' }, '📂 …');
        const ctxRow = el('div', { class: 'cbhcli-ctx-row' });
        const meter = el('div', { class: 'cbhcli-ctx-meter' });
        this._ctxFill = el('div', { class: 'cbhcli-ctx-fill' });
        meter.appendChild(this._ctxFill);
        this._ctxPct = el('span', { class: 'cbhcli-ctx-pct' }, '0%');
        this._ctxFraction = el('span', { class: 'cbhcli-ctx-fraction' }, '0 / 0');
        ctxRow.appendChild(meter);
        ctxRow.appendChild(this._ctxPct);
        ctxRow.appendChild(this._ctxFraction);
        // 小眼睛
        this._eyeWrap = el('div', { class: 'cbhcli-eye-wrap cbhcli-hidden' });
        this._eyeBtn = el('button', {
            class: 'cbhcli-eye-btn on',
            title: '点击开关：是否把选中内容作为上下文',
            onclick: () => this._toggleSelection()
        }, '👁');
        this._eyeInfo = el('span', { class: 'cbhcli-eye-info' }, '');
        this._eyeWrap.appendChild(this._eyeBtn);
        this._eyeWrap.appendChild(this._eyeInfo);
        statusStrip.appendChild(this._pathEl);
        statusStrip.appendChild(ctxRow);
        statusStrip.appendChild(this._eyeWrap);
        chatView.appendChild(statusStrip);
        // 消息区
        this._messagesEl = el('div', { class: 'cbhcli-messages' });
        chatView.appendChild(this._messagesEl);
        // 输入区
        const inputArea = el('div', { class: 'cbhcli-input-area' });
        this._inputEl = el('textarea', {
            class: 'cbhcli-input',
            placeholder: '输入消息…（Shift+Enter 换行，Enter 发送）',
            rows: 3
        });
        inputArea.appendChild(this._inputEl);
        // 动作按钮行：工具 / Skills / MCP / 链条 / 压缩 / 新对话
        const actionRow = el('div', { class: 'cbhcli-action-row' });
        actionRow.appendChild(el('button', { class: 'cbhcli-chip-btn', onclick: () => this._openToolsModal() }, '🔧 工具'));
        actionRow.appendChild(el('button', { class: 'cbhcli-chip-btn', onclick: () => this._openSkillsModal() }, '🎯 Skills'));
        actionRow.appendChild(el('button', { class: 'cbhcli-chip-btn', onclick: () => this._openMcpModal() }, '🔌 MCP'));
        actionRow.appendChild(el('button', { class: 'cbhcli-chip-btn', onclick: () => this._openChainModal() }, '🔗 链条'));
        actionRow.appendChild(el('button', { class: 'cbhcli-chip-btn', onclick: () => this._compress() }, '🗜 压缩'));
        actionRow.appendChild(el('button', { class: 'cbhcli-chip-btn', onclick: () => this._newChat() }, '🔄 新对话'));
        inputArea.appendChild(actionRow);
        // 发送/停止行
        const btnRow = el('div', { class: 'cbhcli-input-btns' });
        this._stopBtn = el('button', {
            class: 'cbhcli-btn cbhcli-btn-stop',
            text: '⏹ 停止',
            disabled: true,
            onclick: () => this._stop()
        });
        this._sendBtn = el('button', {
            class: 'cbhcli-btn cbhcli-btn-primary',
            text: '发送',
            onclick: () => this._send()
        });
        btnRow.appendChild(this._stopBtn);
        btnRow.appendChild(this._sendBtn);
        inputArea.appendChild(btnRow);
        chatView.appendChild(inputArea);
        root.appendChild(chatView);
        // 配置视图
        this._settings.addClass('cbhcli-settings-hidden');
        root.appendChild(this._settings.node);
        // Tab 切换
        tabChat.addEventListener('click', () => {
            tabChat.classList.add('active');
            tabSettings.classList.remove('active');
            chatView.classList.remove('cbhcli-hidden');
            this._settings.node.classList.add('cbhcli-settings-hidden');
        });
        tabSettings.addEventListener('click', () => {
            tabSettings.classList.add('active');
            tabChat.classList.remove('active');
            chatView.classList.add('cbhcli-hidden');
            this._settings.node.classList.remove('cbhcli-settings-hidden');
            void this._settings.refresh();
        });
        // Enter 发送 / Shift+Enter 或 Alt+Enter 换行（仅面板内输入框）
        this._inputEl.addEventListener('keydown', e => {
            var _a, _b;
            if (e.key !== 'Enter') {
                return;
            }
            if (e.shiftKey) {
                return; // Shift+Enter：浏览器默认换行行为
            }
            if (e.altKey) {
                // Alt+Enter：换行（v0.3.1）——部分浏览器 Alt+Enter 默认不插入换行，手动插入
                e.preventDefault();
                const ta = this._inputEl;
                const start = (_a = ta.selectionStart) !== null && _a !== void 0 ? _a : ta.value.length;
                const end = (_b = ta.selectionEnd) !== null && _b !== void 0 ? _b : start;
                ta.value = ta.value.slice(0, start) + '\n' + ta.value.slice(end);
                ta.selectionStart = ta.selectionEnd = start + 1;
                return;
            }
            e.preventDefault();
            this._send();
        });
        return root;
    }
    // ------------------------------------------------------------------
    //  需求7：路径跟随文件浏览器
    // ------------------------------------------------------------------
    _setupPathTracking() {
        // 先取服务器根目录
        apiGet('server_root')
            .then(r => {
            this._serverRoot = (r === null || r === void 0 ? void 0 : r.root) || '';
            this._refreshPath();
        })
            .catch(() => this._refreshPath());
        const factory = this._fbFactory;
        if (!factory) {
            this._pathEl.textContent = '📂 (文件浏览器不可用)';
            return;
        }
        // 当前文件浏览器切换时重新绑定
        try {
            factory.tracker.currentChanged.connect(() => {
                this._bindBrowserPath();
                this._refreshPath();
            });
        }
        catch (_a) {
            /* ignore */
        }
        this._bindBrowserPath();
        this._refreshPath();
    }
    _unbindBrowserPath() {
        var _a;
        if (this._pathSlot && ((_a = this._boundBrowserModel) === null || _a === void 0 ? void 0 : _a.pathChanged)) {
            try {
                this._boundBrowserModel.pathChanged.disconnect(this._pathSlot);
            }
            catch (_b) {
                /* ignore */
            }
        }
        this._pathSlot = null;
        this._boundBrowserModel = null;
    }
    _bindBrowserPath() {
        var _a, _b;
        this._unbindBrowserPath();
        const fb = (_b = (_a = this._fbFactory) === null || _a === void 0 ? void 0 : _a.tracker) === null || _b === void 0 ? void 0 : _b.currentWidget;
        if (fb && fb.model && fb.model.pathChanged) {
            this._pathSlot = () => this._refreshPath();
            this._boundBrowserModel = fb.model;
            fb.model.pathChanged.connect(this._pathSlot);
        }
    }
    _refreshPath() {
        var _a, _b, _c;
        const fb = (_b = (_a = this._fbFactory) === null || _a === void 0 ? void 0 : _a.tracker) === null || _b === void 0 ? void 0 : _b.currentWidget;
        const rel = ((_c = fb === null || fb === void 0 ? void 0 : fb.model) === null || _c === void 0 ? void 0 : _c.path) || '';
        const full = this._joinPath(this._serverRoot, rel);
        this._pathEl.textContent = `📂 ${full || '/'}`;
        this._pathEl.title = full || '/';
        // 目录变化时同步 Agent 工作目录（后端 os.chdir）
        if (rel !== this._currentRelPath) {
            this._currentRelPath = rel;
            void apiPost('set_cwd', { path: rel }).catch(() => undefined);
        }
    }
    _joinPath(root, rel) {
        const r = (root || '').replace(/\/+$/, '');
        if (!rel) {
            return r || '/';
        }
        return `${r}/${rel}`;
    }
    // ------------------------------------------------------------------
    //  需求4：上下文用量（分子/分母 + 进度条）
    // ------------------------------------------------------------------
    _updateCtxMeter(usage) {
        const tokens = Number((usage === null || usage === void 0 ? void 0 : usage.token_estimate) || 0);
        const limit = Number((usage === null || usage === void 0 ? void 0 : usage.model_limit) || 0);
        const pct = Math.min(100, Number((usage === null || usage === void 0 ? void 0 : usage.ctx_percentage) || 0));
        this._ctxFill.style.width = pct + '%';
        this._ctxFill.className =
            'cbhcli-ctx-fill' + (pct >= 80 ? ' danger' : pct >= 50 ? ' warn' : '');
        this._ctxPct.textContent = pct.toFixed(1) + '%';
        this._ctxFraction.textContent = `${fmtNum(tokens)} / ${fmtNum(limit)}`;
        const row = this._ctxFraction.parentElement;
        if (row) {
            row.title = `上下文使用: ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
        }
    }
    // ------------------------------------------------------------------
    //  需求8：实时选区 + 小眼睛
    // ------------------------------------------------------------------
    _startSelectionPoll() {
        if (this._selPollTimer !== null) {
            return;
        }
        this._selPollTimer = window.setInterval(() => this._refreshSelection(), 400);
    }
    _refreshSelection() {
        let ctx = null;
        try {
            ctx = this._nbClient.getCurrentSelectionContext();
        }
        catch (_a) {
            ctx = null;
        }
        const key = ctx ? `${ctx.path}|${ctx.location}|${ctx.text.length}` : '';
        if (!ctx) {
            this._selectionCtx = null;
            this._lastSelKey = '';
            this._eyeWrap.classList.add('cbhcli-hidden');
            return;
        }
        if (key !== this._lastSelKey) {
            // 新选区 → 默认打开
            this._selectionEnabled = true;
            this._lastSelKey = key;
        }
        this._selectionCtx = ctx;
        this._eyeWrap.classList.remove('cbhcli-hidden');
        this._eyeBtn.classList.toggle('on', this._selectionEnabled);
        this._eyeBtn.classList.toggle('off', !this._selectionEnabled);
        const base = ctx.path.split('/').pop() || ctx.path;
        this._eyeInfo.textContent = `${base} · ${ctx.location}`;
        this._eyeInfo.title = ctx.isCursor
            ? `光标位置将作为上下文（在第 ${ctx.startLine} 行）\n点击眼睛开关`
            : `选中内容将作为上下文（${ctx.text.length} 字符）\n点击眼睛开关`;
    }
    _toggleSelection() {
        this._selectionEnabled = !this._selectionEnabled;
        this._eyeBtn.classList.toggle('on', this._selectionEnabled);
        this._eyeBtn.classList.toggle('off', !this._selectionEnabled);
    }
    /** 构造附带选区上下文的完整消息。返回 {display, payload}。 */
    _buildSelectionContext(userText) {
        const ctx = this._selectionCtx;
        if (!ctx || !this._selectionEnabled) {
            return { display: userText, payload: userText };
        }
        const editTool = ctx.source === 'notebook' ? 'nb_edit_cell' : 'nb_file_edit';
        // 光标位置（无文本选中）：引导 agent 在光标处插入代码
        if (ctx.isCursor) {
            const lineBlock = ctx.text
                ? `光标所在行内容：\n\`\`\`\n${ctx.text}\n\`\`\`\n\n`
                : '';
            const cursorPayload = `[光标位置]（${ctx.path} · ${ctx.location}）\n` +
                lineBlock +
                `用户问题：${userText}\n\n` +
                `注意：我的光标位于上述位置（第 ${ctx.startLine} 行第 ${ctx.startCol} 列）。若要在此添加代码，` +
                `调用 ${editTool} 时用 insert_at_line=${ctx.startLine}、insert_at_col=${ctx.startCol} 参数` +
                `插入新代码行，不要整体替换整个 cell/文件。`;
            return { display: userText, payload: cursorPayload };
        }
        const scope = ctx.source === 'notebook' ? 'notebook 选中部分' : '文件选中部分';
        const payload = `[当前选中内容]（${ctx.path} · ${ctx.location}）\n` +
            '```\n' +
            ctx.text +
            '\n```\n\n' +
            `用户问题：${userText}\n\n` +
            `注意：以上是我的${scope}（位置 ${ctx.location}），请仅针对选中内容作答/修改/替换，不要改动非选中部分。` +
            `若要修改，调用 ${editTool} 时用 selection_text 传入与上述选中内容完全一致的文本，` +
            `系统会按编辑器当前选区的精确位置替换（即使行内有重复文本也不会改错位置）。`;
        return { display: userText, payload };
    }
    // ------------------------------------------------------------------
    //  初始化
    // ------------------------------------------------------------------
    async _initChoices(loadSettings) {
        var _a, _b, _c, _d;
        // v0.3.3：先检查后端健康状态。cbhcli 未安装/版本不兼容时（Windows 常见），
        // 后端进入诊断模式：/info 返回 500 + status=error + 安装指引；
        // /info 404 则说明 server extension 根本没加载。两种情况都显示横幅
        // 而不是静默空列表（旧版表现："模型/Agent 识别不到"且无任何提示）。
        try {
            const info = await apiGet('info');
            if ((info === null || info === void 0 ? void 0 : info.status) === 'error') {
                this._showBackendError(info.error || 'cbhcli 后端组件不可用', info.hint || '');
                return;
            }
            this._hideBackendError();
        }
        catch (err) {
            // v5.4.0（认证系统）：本机未登录 -> 未登录提示条（引导 cbhcli login / web 登录界面）
            if (err === null || err === void 0 ? void 0 : err.notLoggedIn) {
                this._showNotLoggedIn();
                return;
            }
            // /info 返回 500（诊断模式）时 requestAPI 抛 ResponseError--
            // 尝试读取响应体里的精确错误与安装指引，失败则用通用文案
            let error = '无法连接 cbhcli 后端服务';
            let hint = 'Jupyter 服务器上的 cbhcli_jupyter 扩展未正确加载，' +
                '请查看 Jupyter 启动日志排查（常见原因：cbhcli 未安装到当前 Python 环境）。';
            try {
                const data = await ((_d = (_b = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.clone) === null || _b === void 0 ? void 0 : (_c = _b.call(_a)).json) === null || _d === void 0 ? void 0 : _d.call(_c));
                if (data === null || data === void 0 ? void 0 : data.error) {
                    error = data.error;
                    hint = data.hint || hint;
                }
            }
            catch (_e) {
                /* keep fallback */
            }
            this._showBackendError(error, hint);
            return;
        }
        try {
            const [agents, models] = await Promise.all([
                apiGet('agents'),
                apiGet('models')
            ]);
            this._agentSelect.innerHTML = '';
            for (const a of (agents === null || agents === void 0 ? void 0 : agents.agents) || []) {
                this._agentSelect.appendChild(el('option', { value: a.name }, a.name));
            }
            this._modelSelect.innerHTML = '';
            for (const m of (models === null || models === void 0 ? void 0 : models.models) || []) {
                this._modelSelect.appendChild(el('option', { value: m.name }, m.name));
            }
            // v0.3.1：首次初始化时恢复上次选择的 Agent（active_agent，与 CLI/Web 一致），
            // 不再固定 main；之后 _agentInited=true 防止覆盖用户当前选择
            if (!this._agentInited) {
                const names = ((agents === null || agents === void 0 ? void 0 : agents.agents) || []).map(a => a.name);
                const active = agents === null || agents === void 0 ? void 0 : agents.active_agent;
                if (active && names.includes(active)) {
                    this._agentName = active;
                }
                else if (names.length > 0) {
                    this._agentName = names[0];
                }
                this._agentInited = true;
            }
            if ((models === null || models === void 0 ? void 0 : models.last_selected) && !this._modelName) {
                this._modelName = models.last_selected;
            }
            if (!this._modelName && ((models === null || models === void 0 ? void 0 : models.models) || []).length > 0) {
                this._modelName = ((models === null || models === void 0 ? void 0 : models.models) || [])[0].name;
            }
            this._modelSelect.value = this._modelName;
            this._agentSelect.value = this._agentName;
            if (loadSettings) {
                void this._settings.refresh();
            }
            this._refreshStatus();
        }
        catch (err) {
            console.error('[cbhcli-jupyter] 初始化失败', err);
        }
    }
    /** v0.3.3：显示后端加载失败横幅（含安装指引）。 */
    _showBackendError(error, hint) {
        this._backendErrorEl.innerHTML = '';
        this._backendErrorEl.appendChild(el('div', { class: 'cbhcli-backend-error-title' }, '⚠️ 后端不可用'));
        this._backendErrorEl.appendChild(el('div', { class: 'cbhcli-backend-error-msg' }, error));
        if (hint) {
            this._backendErrorEl.appendChild(el('div', { class: 'cbhcli-backend-error-hint' }, hint));
        }
        this._backendErrorEl.classList.remove('cbhcli-hidden');
    }
    /** v0.3.3：隐藏后端错误横幅。 */
    _hideBackendError() {
        this._backendErrorEl.classList.add('cbhcli-hidden');
    }
    /** v5.4.0（认证系统）：显示未登录提示横幅（引导 cbhcli login / web 登录界面）。 */
    _showNotLoggedIn() {
        this._backendErrorEl.innerHTML = '';
        this._backendErrorEl.appendChild(el('div', { class: 'cbhcli-backend-error-title' }, '🔐 未登录'));
        this._backendErrorEl.appendChild(el('div', { class: 'cbhcli-backend-error-msg' }, '本机尚未登录 cbhcli。请在终端运行 cbhcli login，或打开 cbhcli web 页面（登录界面）登录，完成后刷新页面。'));
        this._backendErrorEl.classList.remove('cbhcli-hidden');
    }
    _onAgentChange() {
        this._agentName = this._agentSelect.value;
        // v0.3.1：持久化所选 Agent（写 config.json 的 active_agent，与 CLI /agent use 一致），
        // 下次启动插件自动恢复
        void apiPost(`agents/${encodeURIComponent(this._agentName)}/select`).catch(() => undefined);
        this._messagesEl.innerHTML = '';
        this._refreshStatus();
        void this._settings.refresh();
    }
    _onModelChange() {
        const newModel = this._modelSelect.value;
        const oldModel = this._modelName;
        this._modelName = newModel;
        // 原地切换模型（保留会话）
        if (oldModel && oldModel !== newModel) {
            void apiPost('chat/switch_model', {
                agent_name: this._agentName,
                old_model: oldModel,
                new_model: newModel
            }).catch(() => undefined);
        }
        this._refreshStatus();
    }
    async _refreshStatus() {
        try {
            const st = await apiGet(`chat/status?agent_name=${encodeURIComponent(this._agentName)}&model_name=${encodeURIComponent(this._modelName)}`);
            this._updateCtxMeter(st || {});
        }
        catch (_a) {
            /* ignore */
        }
    }
    // ------------------------------------------------------------------
    //  动作按钮：压缩 / 新对话
    // ------------------------------------------------------------------
    async _compress() {
        if (this._busy) {
            this._addSystemNote('⚠️ 正在处理中，请稍候');
            return;
        }
        this._addSystemNote('🗜 正在压缩上下文…');
        try {
            const res = await apiPost('chat/compress', { agent_name: this._agentName, model_name: this._modelName });
            this._addSystemNote((res === null || res === void 0 ? void 0 : res.success) === false ? `⚠️ ${(res === null || res === void 0 ? void 0 : res.message) || '压缩失败'}` : `✅ ${(res === null || res === void 0 ? void 0 : res.message) || '已压缩'}`);
            if (res === null || res === void 0 ? void 0 : res.usage) {
                this._updateCtxMeter(res.usage);
            }
            else {
                this._refreshStatus();
            }
        }
        catch (err) {
            this._addSystemNote(`⚠️ 压缩失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    async _newChat() {
        if (this._busy) {
            this._addSystemNote('⚠️ 正在处理中，请先停止');
            return;
        }
        try {
            await apiPost('chat/reset', {
                agent_name: this._agentName,
                model_name: this._modelName
            });
            this._messagesEl.innerHTML = '';
            this._addSystemNote('🔄 已开启新对话');
            this._refreshStatus();
        }
        catch (err) {
            this._addSystemNote(`⚠️ 新建会话失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    // ------------------------------------------------------------------
    //  动作按钮：工具 / Skills 弹窗（多选，选中即激活）
    // ------------------------------------------------------------------
    _showModal(title, body) {
        const overlay = el('div', { class: 'cbhcli-dialog-overlay' });
        const dlg = el('div', { class: 'cbhcli-dialog cbhcli-dialog-wide' });
        const head = el('div', { class: 'cbhcli-dialog-head' });
        head.appendChild(el('div', { class: 'cbhcli-dialog-title' }, title));
        const closeBtn = el('button', { class: 'cbhcli-dialog-close', text: '✕' });
        head.appendChild(closeBtn);
        dlg.appendChild(head);
        dlg.appendChild(body);
        overlay.appendChild(dlg);
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                close();
            }
        });
        return { overlay, close };
    }
    async _openToolsModal() {
        const body = el('div', { class: 'cbhcli-modal-body' }, '加载中…');
        const { close } = this._showModal('🔧 工具（勾选即启用）', body);
        const load = async () => {
            try {
                const data = await apiGet(`agents/${encodeURIComponent(this._agentName)}/tools`);
                body.innerHTML = '';
                const tools = (data === null || data === void 0 ? void 0 : data.tools) || [];
                if (tools.length === 0) {
                    body.appendChild(el('div', { class: 'cbhcli-empty' }, '（无工具）'));
                    return;
                }
                // 按 category 分组
                const groups = {};
                for (const t of tools) {
                    const cat = t.category || '其他';
                    (groups[cat] = groups[cat] || []).push(t);
                }
                const CAT_LABEL = { builtin: '内置工具', mcp: 'MCP 工具' };
                for (const [cat, list] of Object.entries(groups)) {
                    body.appendChild(el('div', { class: 'cbhcli-modal-group' }, CAT_LABEL[cat] || cat));
                    for (const t of list) {
                        const enabled = t.enabled !== false;
                        const row = el('label', { class: 'cbhcli-check-row' + (enabled ? ' on' : '') });
                        const box = el('input', { type: 'checkbox', checked: enabled });
                        const stateEl = el('span', { class: 'cbhcli-check-state' }, enabled ? '已启用' : '已禁用');
                        box.addEventListener('change', () => {
                            row.classList.toggle('on', box.checked);
                            stateEl.textContent = box.checked ? '已启用' : '已禁用';
                            void apiPut(`agents/${encodeURIComponent(this._agentName)}/tools/${encodeURIComponent(t.name)}`, { enable: box.checked }).catch((err) => {
                                console.error(`工具开关失败 ${t.name}:`, err);
                                box.checked = !box.checked;
                                row.classList.toggle('on', box.checked);
                                stateEl.textContent = box.checked ? '已启用' : '已禁用';
                            });
                        });
                        const nameEl = el('span', { class: 'cbhcli-check-name' }, t.name);
                        nameEl.title = t.description || '';
                        row.appendChild(box);
                        row.appendChild(nameEl);
                        row.appendChild(stateEl);
                        body.appendChild(row);
                    }
                }
            }
            catch (err) {
                body.innerHTML = '';
                body.appendChild(el('div', { class: 'cbhcli-empty' }, `加载失败: ${err}`));
            }
        };
        void load();
        void close; // close 由弹窗内部使用
    }
    async _openSkillsModal() {
        const body = el('div', { class: 'cbhcli-modal-body' }, '加载中…');
        this._showModal('🎯 Skills（勾选即激活）', body);
        const load = async () => {
            try {
                const data = await apiGet(`agents/${encodeURIComponent(this._agentName)}/skills`);
                body.innerHTML = '';
                const skills = (data === null || data === void 0 ? void 0 : data.skills) || [];
                if (skills.length === 0) {
                    body.appendChild(el('div', { class: 'cbhcli-empty' }, '（无技能，可用 /skills add 创建）'));
                    return;
                }
                for (const s of skills) {
                    const active = !!s.active;
                    const row = el('label', { class: 'cbhcli-check-row' + (active ? ' on' : '') });
                    const box = el('input', { type: 'checkbox', checked: active });
                    box.addEventListener('change', () => {
                        row.classList.toggle('on', box.checked);
                        if (box.checked) {
                            void apiPost(`agents/${encodeURIComponent(this._agentName)}/skills/activate`, { names: [s.name] }).catch(() => {
                                box.checked = false;
                                row.classList.remove('on');
                            });
                        }
                        else {
                            void apiPost(`agents/${encodeURIComponent(this._agentName)}/skills/${encodeURIComponent(s.name)}/deactivate`).catch(() => {
                                box.checked = true;
                                row.classList.add('on');
                            });
                        }
                    });
                    const nameEl = el('span', { class: 'cbhcli-check-name' }, s.name);
                    nameEl.title = s.prompt_preview || s.prompt || '';
                    row.appendChild(box);
                    row.appendChild(nameEl);
                    row.appendChild(el('span', { class: 'cbhcli-check-state' }, active ? '已激活' : '未激活'));
                    body.appendChild(row);
                }
            }
            catch (err) {
                body.innerHTML = '';
                body.appendChild(el('div', { class: 'cbhcli-empty' }, `加载失败: ${err}`));
            }
        };
        void load();
    }
    /** 轻量 MCP 弹窗：列出各 MCP 服务器的工具并勾选启用/禁用。 */
    async _openMcpModal() {
        const body = el('div', { class: 'cbhcli-modal-body' }, '加载中…');
        this._showModal('🔌 MCP 工具（勾选即启用）', body);
        const agent = encodeURIComponent(this._agentName);
        const load = async () => {
            try {
                const data = await apiGet(`agents/${agent}/mcp`);
                const servers = (data === null || data === void 0 ? void 0 : data.servers) || [];
                body.innerHTML = '';
                if (servers.length === 0) {
                    body.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无 MCP 服务器（可在「配置」页添加）'));
                    return;
                }
                for (const s of servers) {
                    body.appendChild(el('div', { class: 'cbhcli-modal-group' }, `🔌 ${s.name}${s.connected ? '' : '（未连接）'}`));
                    let tools = [];
                    try {
                        const td = await apiGet(`agents/${agent}/mcp/${encodeURIComponent(s.name)}/tools`);
                        tools = (td === null || td === void 0 ? void 0 : td.tools) || [];
                    }
                    catch (_a) {
                        tools = [];
                    }
                    if (tools.length === 0) {
                        body.appendChild(el('div', { class: 'cbhcli-empty' }, '（该服务器暂无工具）'));
                        continue;
                    }
                    for (const t of tools) {
                        const enabled = t.enabled !== false;
                        const row = el('label', { class: 'cbhcli-check-row' + (enabled ? ' on' : '') });
                        const box = el('input', { type: 'checkbox', checked: enabled });
                        box.addEventListener('change', () => {
                            row.classList.toggle('on', box.checked);
                            void apiPut(`agents/${agent}/mcp/${encodeURIComponent(s.name)}/tools/${encodeURIComponent(t.name)}`, { enable: box.checked }).catch(() => {
                                box.checked = !box.checked;
                                row.classList.toggle('on', box.checked);
                            });
                        });
                        const nameEl = el('span', { class: 'cbhcli-check-name' }, t.name);
                        nameEl.title = t.description || '';
                        row.appendChild(box);
                        row.appendChild(nameEl);
                        row.appendChild(el('span', { class: 'cbhcli-check-state' }, enabled ? '已启用' : '已禁用'));
                        body.appendChild(row);
                    }
                }
            }
            catch (err) {
                body.innerHTML = '';
                body.appendChild(el('div', { class: 'cbhcli-empty' }, `加载失败: ${err}`));
            }
        };
        void load();
    }
    /** 轻量链条弹窗：单选激活/取消当前会话的链条（仿 web showChainPicker）。 */
    async _openChainModal() {
        const body = el('div', { class: 'cbhcli-modal-body' }, '加载中…');
        this._showModal(`🔗 Agent 链条 - ${this._agentName}`, body);
        const load = async () => {
            try {
                const [chainsData, status] = await Promise.all([
                    apiGet('chains'),
                    apiGet(`chat/status?agent_name=${encodeURIComponent(this._agentName)}` +
                        `&model_name=${encodeURIComponent(this._modelName)}`)
                ]);
                const chains = (chainsData === null || chainsData === void 0 ? void 0 : chainsData.chains) || [];
                const activeChain = (status === null || status === void 0 ? void 0 : status.active_chain) || null;
                // 只显示当前 Agent 是元 Agent 的链条（与 CLI / web 一致）
                const available = chains.filter(c => {
                    const root = (c.levels || [])[0];
                    return root && root.agents && root.agents.length &&
                        root.agents[0].name === this._agentName;
                });
                body.innerHTML = '';
                const makeRow = (name, desc, isActive) => {
                    const radio = el('input', {
                        type: 'radio', name: 'cbhcli-chain-pick', value: name
                    });
                    radio.checked = isActive;
                    const row = el('label', { class: 'cbhcli-check-row' + (isActive ? ' on' : '') });
                    row.appendChild(radio);
                    row.appendChild(el('span', { class: 'cbhcli-check-name' }, name === '' ? '无链条（单 Agent 模式）' : `🔗 ${name}`));
                    row.appendChild(el('span', { class: 'cbhcli-check-state' }, desc));
                    return row;
                };
                body.appendChild(makeRow('', '普通单 Agent 模式', !activeChain));
                for (const c of available) {
                    const invalid = c.valid === false ? '（无效）' : '';
                    body.appendChild(makeRow(c.name, `${c.description || ''}${invalid}`, activeChain === c.name));
                }
                if (available.length === 0) {
                    body.appendChild(el('div', { class: 'cbhcli-empty' }, `当前 Agent '${this._agentName}' 没有以其为元 Agent 的链条。可用 CLI /chain 或 web 创建。`));
                }
                // 选择即激活 / 取消
                body.addEventListener('change', async (e) => {
                    const target = e.target;
                    if (!target || target.name !== 'cbhcli-chain-pick') {
                        return;
                    }
                    try {
                        if (target.value) {
                            await apiPost('chat/use-chain', {
                                agent_name: this._agentName, model_name: this._modelName, chain_name: target.value
                            });
                        }
                        else {
                            await apiPost('chat/off-chain', {
                                agent_name: this._agentName, model_name: this._modelName
                            });
                        }
                        void this._refreshStatus();
                    }
                    catch (err) {
                        body.appendChild(el('div', { class: 'cbhcli-empty' }, `操作失败: ${err}`));
                    }
                });
            }
            catch (err) {
                body.innerHTML = '';
                body.appendChild(el('div', { class: 'cbhcli-empty' }, `加载失败: ${err}`));
            }
        };
        void load();
    }
    // ------------------------------------------------------------------
    //  消息渲染（块指针模式：用户→思考→工具→输出 依次出现）
    // ------------------------------------------------------------------
    _addUserMessage(text, withSelection) {
        var _a;
        const bubble = el('div', { class: 'cbhcli-msg cbhcli-msg-user' });
        const body = el('div', { class: 'cbhcli-msg-user-bubble' });
        if (withSelection) {
            const note = ((_a = this._selectionCtx) === null || _a === void 0 ? void 0 : _a.isCursor)
                ? '👁 已附带光标位置作为上下文'
                : '👁 已附带选中内容作为上下文';
            body.appendChild(el('div', { class: 'cbhcli-msg-sel-note' }, note));
        }
        body.appendChild(el('div', { class: 'cbhcli-msg-text' }, text));
        bubble.appendChild(body);
        this._messagesEl.appendChild(bubble);
        this._scrollBottom();
    }
    _addSystemNote(text) {
        this._messagesEl.appendChild(el('div', { class: 'cbhcli-system-note' }, text));
        this._scrollBottom();
    }
    _scrollBottom() {
        this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
    }
    // ------------------------------------------------------------------
    //  发送 / 停止
    // ------------------------------------------------------------------
    _send() {
        const text = this._inputEl.value.trim();
        if (!text || this._busy) {
            return;
        }
        if (!this._modelName) {
            this._addSystemNote('⚠️ 尚未选择模型，请先在「配置」中添加并选择模型');
            return;
        }
        this._inputEl.value = '';
        const { display, payload } = this._buildSelectionContext(text);
        // 严格模式：nb 工具仅在「注入了选区上下文」(小眼睛开+有选区)时启用，
        // 其余情况(小眼睛关/无选区)禁用，agent 只做普通问答+非 nb 内置工具调用。
        const nbEnabled = payload !== display;
        this._addUserMessage(display, nbEnabled);
        void this._runChat(payload, nbEnabled);
    }
    _stop() {
        // v0.3.2：对齐 cbhcli Web 的停止语义——只请求后端中断（chat/abort），
        // SSE 流保持打开，等后端在下一个检查点（流式轮询/工具执行间隙，≤0.5s；
        // 正在执行的 nb 工具由后端 cancel_all 立即唤醒）发出 aborted 事件并结束流，
        // 由 onDone 统一复位 UI。
        //
        // 旧实现立刻 controller.abort() 掐断 fetch 有两个问题：
        // ① 浏览器断流但后端仍在跑（工具线程照常执行，notebook cell 一路跑完），
        //   表现为"停止不停任务"；
        // ② fetch 中断被 ServerConnection 包装成 TypeError（name 非 AbortError），
        //   显示 "❌ 连接错误: signal is aborted without reason"。
        const streamFn = this._abortFn;
        void apiPost('chat/abort', {
            agent_name: this._agentName,
            model_name: this._modelName
        }).catch(() => undefined);
        this._addSystemNote('⏹ 已请求中断，等待当前步骤收尾…');
        // 兜底：若后端 30s 内仍未结束流（异常挂死），强制断开并复位 UI。
        // 通过捕获本次流的 abort 函数做身份校验，避免误杀用户新发起的请求。
        window.setTimeout(() => {
            if (this._busy && streamFn !== null && this._abortFn === streamFn) {
                streamFn();
                this._setBusy(false);
            }
        }, 30000);
    }
    _setBusy(busy) {
        this._busy = busy;
        this._sendBtn.disabled = busy;
        this._stopBtn.disabled = !busy;
        this._inputEl.disabled = busy;
    }
    // ------------------------------------------------------------------
    //  聊天主流程（SSE + 块指针渲染）
    // ------------------------------------------------------------------
    async _runChat(message, nbEnabled) {
        this._setBusy(true);
        // AI 消息容器
        const aiMsg = el('div', { class: 'cbhcli-msg cbhcli-msg-ai' });
        const aiBody = el('div', { class: 'cbhcli-msg-ai-body' });
        aiMsg.appendChild(aiBody);
        this._messagesEl.appendChild(aiMsg);
        this._scrollBottom();
        // 当前块指针
        let curReasoning = null;
        let curContent = null;
        const toolCards = new Map();
        const closeReasoning = () => {
            var _a;
            if (curReasoning) {
                (_a = curReasoning.blockEl.querySelector('.cbhcli-thinking-dot')) === null || _a === void 0 ? void 0 : _a.remove();
                curReasoning.blockEl.classList.remove('open');
                curReasoning = null;
            }
        };
        const closeContent = () => {
            curContent = null;
        };
        const ensureReasoning = () => {
            if (curReasoning) {
                return curReasoning;
            }
            closeContent();
            const textEl = el('div', { class: 'cbhcli-thinking-content' });
            const blockEl = el('div', { class: 'cbhcli-thinking-block open' }, el('div', { class: 'cbhcli-thinking-header' }, el('span', { class: 'cbhcli-arrow' }, '▶'), el('span', {}, '思考过程'), el('span', { class: 'cbhcli-thinking-dot' })), textEl);
            blockEl
                .querySelector('.cbhcli-thinking-header')
                .addEventListener('click', () => blockEl.classList.toggle('open'));
            aiBody.appendChild(blockEl);
            curReasoning = { content: '', textEl, blockEl };
            this._scrollBottom();
            return curReasoning;
        };
        const ensureContent = () => {
            if (curContent) {
                return curContent;
            }
            closeReasoning();
            const mdEl = el('div', { class: 'cbhcli-msg-content' });
            aiBody.appendChild(mdEl);
            curContent = { raw: '', el: mdEl };
            return curContent;
        };
        const addSysEvent = (text, cls = '') => {
            closeReasoning();
            closeContent();
            aiBody.appendChild(el('div', { class: `cbhcli-sys-event ${cls}` }, text));
            this._scrollBottom();
        };
        const ensureToolCard = (toolId, name) => {
            if (toolCards.has(toolId)) {
                return toolCards.get(toolId);
            }
            closeReasoning();
            closeContent();
            const statusEl = el('span', { class: 'cbhcli-tool-status pending' }, '等待确认');
            const bodyEl = el('div', { class: 'cbhcli-tool-body' });
            const cardEl = el('div', { class: 'cbhcli-tool-card open' }, el('div', { class: 'cbhcli-tool-header' }, el('span', { class: 'cbhcli-arrow' }, '▶'), el('span', { class: 'cbhcli-tool-name' }, `🔧 ${name}`), statusEl), bodyEl);
            cardEl
                .querySelector('.cbhcli-tool-header')
                .addEventListener('click', () => cardEl.classList.toggle('open'));
            aiBody.appendChild(cardEl);
            const rec = { toolId, name, cardEl, statusEl, bodyEl, confirmEl: null };
            toolCards.set(toolId, rec);
            this._scrollBottom();
            return rec;
        };
        const setToolStatus = (rec, text, cls) => {
            rec.statusEl.className = `cbhcli-tool-status ${cls}`;
            rec.statusEl.textContent = text;
        };
        // Todo 专用任务面板：每调用一次 Todo 就在当前位置追加一个任务面板，
        // 展示该时刻的任务进度（✓/◐/○），让用户清楚进行到哪一步（不建工具卡片、不显示 JSON）。
        const showTodoPanel = (args) => {
            const todos = normalizeTodos(args);
            if (todos.length === 0) {
                return;
            }
            closeReasoning();
            closeContent();
            aiBody.appendChild(todoPanelEl(todos));
            this._scrollBottom();
        };
        const respond = (response) => {
            void apiPost('chat/respond', {
                agent_name: this._agentName,
                model_name: this._modelName,
                response
            }).catch(() => undefined);
        };
        const handlers = {
            reasoning: d => {
                const r = ensureReasoning();
                r.content += d.content || '';
                r.textEl.textContent = r.content;
                this._scrollBottom();
            },
            content: d => {
                const c = ensureContent();
                c.raw += d.content || '';
                c.el.innerHTML = renderMarkdown(c.raw);
                enhanceCodeBlocks(c.el);
                this._scrollBottom();
            },
            tool_confirm: d => {
                // Todo 工具：直接展示任务面板，不创建工具卡片（避免显示 JSON 串）
                if (d.tool_name === 'Todo') {
                    showTodoPanel(d.tool_args);
                    return;
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                // 渲染工具参数（python 代码 / edit diff / write 内容等，仿 web）
                try {
                    if (d.tool_args && Object.keys(d.tool_args).length > 0) {
                        renderToolArgs(rec.bodyEl, d.tool_name || '', d.tool_args);
                    }
                    else if (d.preview) {
                        rec.bodyEl.appendChild(el('pre', { class: 'cbhcli-tool-preview' }, stripAnsi(String(d.preview)).slice(0, 500)));
                    }
                }
                catch (_a) {
                    /* 参数渲染失败时忽略 */
                }
                if (d.needs_confirm) {
                    setToolStatus(rec, '等待确认', 'pending');
                    const btns = el('div', { class: 'cbhcli-tool-confirm' });
                    btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-primary', onclick: () => { var _a; respond('y'); (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove(); } }, '✅ 允许'));
                    btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => { var _a; respond('n'); (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove(); } }, '❌ 拒绝'));
                    btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => { var _a; respond('all'); (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove(); } }, '⚡ 本次全部'));
                    btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => { var _a; respond('always'); (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove(); } }, '★ 永久'));
                    rec.confirmEl = btns;
                    rec.cardEl.appendChild(btns);
                }
                else {
                    setToolStatus(rec, '自动放行', 'auto');
                }
            },
            tool_auto_confirmed: d => {
                if (d.tool_name === 'Todo') {
                    return;
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                setToolStatus(rec, '已自动确认', 'auto');
            },
            tool_executing: d => {
                if (d.tool_name === 'Todo') {
                    return;
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                setToolStatus(rec, '执行中…', 'running');
            },
            tool_result: d => {
                var _a;
                if (d.tool_name === 'Todo') {
                    return; // 任务面板已在 confirm 阶段展示
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                const okk = d.success !== false;
                setToolStatus(rec, okk ? '✅ 完成' : '❌ 失败', okk ? 'success' : 'error');
                (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove();
                rec.confirmEl = null;
                // 渲染输出（去 ANSI 乱码），保留上方已渲染的参数
                try {
                    if (d.preview !== undefined && d.preview !== null && String(d.preview).trim()) {
                        renderToolResult(rec.bodyEl, d.tool_name || '', String(d.preview), okk);
                    }
                }
                catch (_b) {
                    /* ignore */
                }
                this._scrollBottom();
            },
            tool_rejected: d => {
                var _a;
                if (d.tool_name === 'Todo') {
                    return;
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                setToolStatus(rec, '已拒绝', 'error');
                (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove();
            },
            tool_denied: d => {
                var _a;
                if (d.tool_name === 'Todo') {
                    return;
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                setToolStatus(rec, '⛔ 被拦截', 'error');
                (_a = rec.confirmEl) === null || _a === void 0 ? void 0 : _a.remove();
                addSysEvent(`🚫 ${d.reason || '操作被权限规则拒绝'}`, 'error');
            },
            tool_yolo_warn: d => {
                if (d.tool_name === 'Todo') {
                    return;
                }
                const rec = ensureToolCard(d.tool_id || '', d.tool_name || '');
                setToolStatus(rec, '⚠️ 红线警告', 'auto');
            },
            loop_detected: d => {
                addSysEvent(`🔁 检测到重复循环（${d.tool_name || ''}），已自动处理`, 'warn');
            },
            rule_added: d => {
                addSysEvent(`★ 已添加永久规则: ${d.rule || ''}`, 'success');
            },
            hook_output: d => {
                addSysEvent(`🔌 [${d.event}] ${d.content || ''}`, 'info');
            },
            reflection: d => {
                addSysEvent(`🔁 ${d.tool_name || ''} 执行失败，自我反思重试 (${d.retry}/${d.max_retries})…`, 'warn');
            },
            ask_user: d => {
                closeReasoning();
                closeContent();
                const overlay = el('div', { class: 'cbhcli-dialog-overlay' });
                const dlg = el('div', { class: 'cbhcli-dialog' });
                dlg.appendChild(el('div', { class: 'cbhcli-dialog-title' }, '🤔 AI 需要你的输入'));
                dlg.appendChild(el('div', { class: 'cbhcli-dialog-body' }, d.question || ''));
                const opts = (d.options || []).filter((o) => typeof o === 'string');
                const btns = el('div', { class: 'cbhcli-dialog-actions' });
                for (const o of opts) {
                    btns.appendChild(el('button', { class: 'cbhcli-btn', onclick: () => { overlay.remove(); respond(o); } }, o));
                }
                btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-primary', onclick: () => { overlay.remove(); respond('用户未回答'); } }, '跳过'));
                dlg.appendChild(btns);
                overlay.appendChild(dlg);
                document.body.appendChild(overlay);
            },
            compressing: d => addSysEvent(`🗜 ${d.content || '正在压缩上下文…'}`, 'warn'),
            compressed: d => {
                addSysEvent(`✅ ${d.content || '上下文已压缩'}`, 'success');
                this._refreshStatus();
            },
            compress_failed: d => addSysEvent(`⚠️ ${d.content || '压缩失败'}`, 'warn'),
            fallback: d => addSysEvent(`🔁 ${d.content || '切换备用模型…'}`, 'warn'),
            error: d => addSysEvent(`❌ ${d.content || '发生错误'}`, 'error'),
            aborted: () => addSysEvent('⏹ 已中断', 'warn')
        };
        this._abortFn = streamChat({
            agent_name: this._agentName,
            model_name: this._modelName,
            message,
            cwd: this._currentRelPath,
            nb_enabled: nbEnabled
        }, ev => {
            const h = handlers[ev.type];
            if (h) {
                try {
                    h(ev);
                }
                catch (e) {
                    console.error(`SSE 事件处理异常 [${ev.type}]`, e);
                }
            }
        }, err => {
            // v5.4.0（认证系统）：本机未登录 -> 未登录提示条
            if (err === null || err === void 0 ? void 0 : err.notLoggedIn) {
                this._showNotLoggedIn();
                return;
            }
            // v0.3.1：409 conflict 友好提示（中断后上一请求尚在收尾；后端已会等待锁释放，
            // 仍报 409 说明上一请求长时间未结束）
            const msg = (err === null || err === void 0 ? void 0 : err.message) || '';
            if (/处理中|Conflict/i.test(msg)) {
                this._addSystemNote('⚠️ 上一请求尚未结束（可能正在收尾），请稍候再发送');
            }
            else {
                this._addSystemNote(`❌ 连接错误: ${msg}`);
            }
        }, () => {
            this._setBusy(false);
            this._abortFn = null;
            // 回复完成后渲染 mermaid / echarts 图表（流式中先显示代码）
            void renderDiagrams(aiBody);
            void this._refreshStatus();
        });
    }
}

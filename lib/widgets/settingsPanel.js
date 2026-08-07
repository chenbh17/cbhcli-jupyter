/**
 * 配置面板（v0.2 重构，仿 cbhcli Web 管理界面）。
 *
 * 分区：模型管理 / 备用模型（可增删排序）/ 权限模式 / 历史会话。
 * Agent 与当前模型的选择只在主面板顶栏，这里不再重复显示。
 */
import { Widget } from '@lumino/widgets';
import { apiGet, apiPost, apiPut, apiDelete } from '../api';
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
// ---------------------------------------------------------------------------
//  配置面板
// ---------------------------------------------------------------------------
export class SettingsPanel extends Widget {
    constructor(_ctx) {
        super();
        this._ctx = _ctx;
        /** 各分区折叠状态（key -> true=收起）。跨 refresh 保留（v0.2.15 通用折叠）。 */
        this._collapsed = {};
        this.addClass('cbhcli-settings');
        this._root = el('div', { class: 'cbhcli-settings-root' });
        this.node.appendChild(this._root);
        void this.refresh();
    }
    async refresh() {
        this._root.innerHTML = '';
        // 模型管理
        this._root.appendChild(await this._buildModelsSection());
        // 备用模型
        this._root.appendChild(await this._buildFallbackSection());
        // MCP 服务器（列表+工具开关+刷新/删除+添加）
        this._root.appendChild(await this._buildMcpSection());
        // Agent 链条（列表+树+激活/取消）
        this._root.appendChild(await this._buildChainSection());
        // 知识库（v0.2.15 新增：列表+添加+删除+重建索引+向量状态）
        this._root.appendChild(await this._buildKnowledgeSection());
        // 权限模式
        this._root.appendChild(await this._buildPermissionsSection());
        // 历史会话
        this._root.appendChild(await this._buildHistorySection());
    }
    // ------------------------------------------------------------------
    //  模型管理
    // ------------------------------------------------------------------
    async _buildModelsSection() {
        const group = this._section('🧠 模型管理', undefined, 'models');
        let models = [];
        try {
            const data = await apiGet('models');
            models = (data === null || data === void 0 ? void 0 : data.models) || [];
        }
        catch (_a) {
            models = [];
        }
        const current = this._ctx.getModel();
        const list = el('div', { class: 'cbhcli-model-list' });
        if (models.length === 0) {
            list.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无模型，请点击「添加模型」配置 API Key'));
        }
        for (const m of models) {
            const card = el('div', { class: 'cbhcli-model-card' + (m.name === current ? ' active' : '') });
            const info = el('div', { class: 'cbhcli-model-info' });
            const tags = [];
            if (m.vision) {
                tags.push('🖼 视觉');
            }
            if (m.thinking) {
                tags.push('🧠 思考');
            }
            if (m.max_tokens) {
                tags.push(`mt=${m.max_tokens}`);
            }
            if (m.context_limit) {
                tags.push(`ctx=${m.context_limit}`);
            }
            info.appendChild(el('div', { class: 'cbhcli-model-name' }, `${m.name === current ? '● ' : ''}${m.name}  ${tags.join(' ')}`));
            info.appendChild(el('div', { class: 'cbhcli-model-detail' }, `${m.model || ''}${m.baseUrl ? ' @ ' + m.baseUrl : ''}`));
            card.appendChild(info);
            const btns = el('div', { class: 'cbhcli-model-actions' });
            if (m.name !== current) {
                btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => this._selectModel(m.name) }, '使用'));
            }
            btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => this._editModel(m) }, '编辑'));
            btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._deleteModel(m.name) }, '删除'));
            card.appendChild(btns);
            list.appendChild(card);
        }
        group.appendChild(list);
        group.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-primary', onclick: () => this._addModel() }, '➕ 添加模型'));
        return group;
    }
    // ------------------------------------------------------------------
    //  备用模型（可配置）
    // ------------------------------------------------------------------
    async _buildFallbackSection() {
        const group = this._section('🔁 备用模型', '主模型异常时按顺序自动切换；视觉模型同理（image 工具）', 'fallback');
        let data = { main: [], vision: [], available_models: [] };
        try {
            data = await apiGet('fallback');
        }
        catch (_a) {
            /* keep empty */
        }
        group.appendChild(this._fallbackCategory('main', '🧠 主模型备用', data));
        group.appendChild(this._fallbackCategory('vision', '👁 视觉模型备用', data));
        return group;
    }
    _fallbackCategory(cat, title, data) {
        const list = data[cat] || [];
        const available = data.available_models || [];
        const wrap = el('div', { class: 'cbhcli-fb-cat' });
        wrap.appendChild(el('div', { class: 'cbhcli-fb-title' }, title));
        if (list.length === 0) {
            wrap.appendChild(el('div', { class: 'cbhcli-empty' }, '（未配置）'));
        }
        else {
            const listEl = el('div', { class: 'cbhcli-fb-list' });
            list.forEach((name, i) => {
                const configured = available.some(x => x.name === name);
                const item = el('div', { class: 'cbhcli-fb-item' });
                item.appendChild(el('span', { class: 'cbhcli-fb-idx' }, String(i + 1)));
                item.appendChild(el('span', { class: 'cbhcli-fb-name' }, name));
                item.appendChild(el('span', { class: 'cbhcli-tag ' + (configured ? 'green' : 'red') }, configured ? '已配置' : '未配置'));
                const btns = el('div', { class: 'cbhcli-fb-btns' });
                btns.appendChild(el('button', {
                    class: 'cbhcli-btn cbhcli-btn-small', title: '上移', disabled: i === 0 ? true : null,
                    onclick: () => this._reorderFallback(cat, list, i, i - 1)
                }, '↑'));
                btns.appendChild(el('button', {
                    class: 'cbhcli-btn cbhcli-btn-small', title: '下移', disabled: i === list.length - 1 ? true : null,
                    onclick: () => this._reorderFallback(cat, list, i, i + 1)
                }, '↓'));
                btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._removeFallback(cat, name) }, '移除'));
                item.appendChild(btns);
                listEl.appendChild(item);
            });
            wrap.appendChild(listEl);
        }
        // 添加行
        const sel = el('select', { class: 'cbhcli-select cbhcli-fb-select' });
        const candidates = available.filter(x => !list.includes(x.name) && (cat === 'main' || x.vision));
        sel.appendChild(el('option', { value: '' }, '选择模型…'));
        for (const c of candidates) {
            sel.appendChild(el('option', { value: c.name }, c.name + (c.vision ? ' 👁' : '')));
        }
        const row = el('div', { class: 'cbhcli-fb-addrow' });
        row.appendChild(sel);
        row.appendChild(el('button', {
            class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-primary',
            onclick: () => this._addFallback(cat, sel.value)
        }, '添加'));
        if (list.length > 0) {
            row.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._clearFallback(cat) }, '清空'));
        }
        wrap.appendChild(row);
        return wrap;
    }
    async _addFallback(cat, name) {
        if (!name) {
            alert('请选择模型');
            return;
        }
        try {
            await apiPost('fallback', { category: cat, model_name: name });
            this.refresh();
        }
        catch (err) {
            alert(`添加失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    async _removeFallback(cat, name) {
        try {
            await apiDelete(`fallback/${cat}/${encodeURIComponent(name)}`);
            this.refresh();
        }
        catch (err) {
            alert(`移除失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    async _clearFallback(cat) {
        if (!confirm(`确定清空 ${cat} 备用列表吗？`)) {
            return;
        }
        try {
            await apiDelete(`fallback/clear/${cat}`);
            this.refresh();
        }
        catch (err) {
            alert(`清空失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    async _reorderFallback(cat, list, from, to) {
        if (to < 0 || to >= list.length) {
            return;
        }
        const order = [...list];
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        try {
            await apiPut(`fallback/reorder/${cat}`, { order });
            this.refresh();
        }
        catch (err) {
            alert(`排序失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    // ------------------------------------------------------------------
    //  权限模式
    // ------------------------------------------------------------------
    async _buildPermissionsSection() {
        const group = this._section('🛡️ 权限模式', '控制工具调用的确认策略', 'permissions');
        let perms = { mode: 'standard', modes: [], rules: {} };
        try {
            perms = await apiGet('permissions');
        }
        catch (_a) {
            /* keep default */
        }
        const row = el('div', { class: 'cbhcli-settings-row' });
        const sel = el('select', { class: 'cbhcli-select' });
        const modes = (perms.modes && perms.modes.length ? perms.modes : ['readonly', 'standard', 'auto', 'yolo'].map(m => ({ id: m, label: m })));
        for (const m of modes) {
            sel.appendChild(el('option', { value: m.id }, `${m.icon || ''} ${m.label || m.id}`.trim()));
        }
        sel.value = perms.mode || 'standard';
        sel.addEventListener('change', () => this._setPermissionMode(sel.value));
        row.appendChild(el('label', { class: 'cbhcli-label' }, '当前模式'));
        row.appendChild(sel);
        group.appendChild(row);
        // 当前模式描述
        const cur = (perms.modes || []).find((m) => m.id === perms.mode);
        if (cur === null || cur === void 0 ? void 0 : cur.desc) {
            group.appendChild(el('div', { class: 'cbhcli-perm-desc' }, cur.desc));
        }
        // 用户规则展示
        const rules = perms.rules || {};
        const ruleWrap = el('div', { class: 'cbhcli-perm-rules' });
        let hasRule = false;
        for (const cat of ['deny', 'ask', 'allow']) {
            const list = (rules[cat] || []);
            if (!list.length) {
                continue;
            }
            hasRule = true;
            ruleWrap.appendChild(el('div', { class: 'cbhcli-perm-cat' }, `${cat} (${list.length})`));
            for (const r of list) {
                ruleWrap.appendChild(el('div', { class: 'cbhcli-perm-rule' }, r));
            }
        }
        if (hasRule) {
            group.appendChild(ruleWrap);
        }
        return group;
    }
    async _setPermissionMode(mode) {
        try {
            await apiPost('permissions/mode', { mode });
            this.refresh();
        }
        catch (err) {
            alert(`设置失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    // ------------------------------------------------------------------
    //  历史会话
    // ------------------------------------------------------------------
    async _buildHistorySection() {
        const agent = this._ctx.getAgent();
        let sessions = [];
        try {
            const data = await apiGet(`agents/${encodeURIComponent(agent)}/history`);
            sessions = (data === null || data === void 0 ? void 0 : data.sessions) || [];
        }
        catch (_a) {
            sessions = [];
        }
        // 通用折叠（v0.2.15）
        const group = this._section(`🕘 历史会话（${sessions.length}）`, undefined, 'history');
        const list = el('div', { class: 'cbhcli-history-list' });
        if (sessions.length === 0) {
            list.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无历史会话'));
        }
        else {
            // 显示会话标题（首条用户消息）+ 条数 + 日期，而非仅 JSON 文件名
            for (const s of sessions.slice(0, 50)) {
                list.appendChild(this._historyItem(s));
            }
        }
        group.appendChild(list);
        return group;
    }
    /** 单个历史会话条目：标题（首条用户消息）+ 元信息 + 恢复/删除。 */
    _historyItem(s) {
        const item = el('div', { class: 'cbhcli-history-item' });
        const main = el('div', { class: 'cbhcli-history-main' });
        const title = (s.title || '').trim() || s.filename || s.id || '空会话';
        const titleEl = el('div', { class: 'cbhcli-history-title-text' }, title);
        titleEl.title = s.filename || ''; // 悬停显示文件名
        main.appendChild(titleEl);
        const metaText = `${s.message_count || 0} 条` +
            (s.created_at ? ` · ${this._fmtHistoryDate(s.created_at)}` : '');
        main.appendChild(el('div', { class: 'cbhcli-history-meta' }, metaText));
        item.appendChild(main);
        const btns = el('div', { class: 'cbhcli-model-actions' });
        btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => this._loadHistory(s.filename) }, '恢复'));
        btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._deleteHistory(s.filename) }, '删除'));
        item.appendChild(btns);
        return item;
    }
    /** ISO 时间 → "MM-DD HH:mm"。 */
    _fmtHistoryDate(iso) {
        if (!iso) {
            return '';
        }
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) {
                return '';
            }
            const pad = (n) => String(n).padStart(2, '0');
            return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        catch (_a) {
            return '';
        }
    }
    async _loadHistory(filename) {
        try {
            await apiPost('chat/load', {
                agent_name: this._ctx.getAgent(),
                model_name: this._ctx.getModel(),
                filename
            });
            this._ctx.notify();
        }
        catch (err) {
            alert(`恢复失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    async _deleteHistory(filename) {
        if (!confirm(`删除历史会话 '${filename}'？`)) {
            return;
        }
        try {
            await apiDelete(`agents/${encodeURIComponent(this._ctx.getAgent())}/history/${encodeURIComponent(filename)}`);
            this.refresh();
        }
        catch (err) {
            alert(`删除失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    // ------------------------------------------------------------------
    //  模型操作
    // ------------------------------------------------------------------
    async _selectModel(name) {
        try {
            // 原地切换模型（保留会话），与顶栏模型下拉一致（v0.2.15 修复 models/select 参数不匹配）
            await apiPost('chat/switch_model', {
                agent_name: this._ctx.getAgent(),
                old_model: this._ctx.getModel(),
                new_model: name
            });
            this._ctx.notify();
            this.refresh();
        }
        catch (err) {
            alert(`切换失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    _addModel() {
        const form = this._modelForm(null);
        this._showDialog('添加模型', form, async () => {
            const data = this._collectForm(form);
            await apiPost('models', data);
            this.refresh();
            this._ctx.notify();
        });
    }
    _editModel(m) {
        const form = this._modelForm(m);
        this._showDialog('编辑模型', form, async () => {
            const data = this._collectForm(form);
            await apiPut(`models/${encodeURIComponent(m.name)}`, data);
            this.refresh();
            this._ctx.notify();
        });
    }
    async _deleteModel(name) {
        if (!confirm(`确认删除模型 '${name}'？`)) {
            return;
        }
        try {
            await apiDelete(`models/${encodeURIComponent(name)}`);
            this.refresh();
            this._ctx.notify();
        }
        catch (err) {
            alert(`删除失败: ${err instanceof Error ? err.message : err}`);
        }
    }
    _modelForm(m) {
        const wrap = el('div', { class: 'cbhcli-form' });
        const fields = [
            ['name', '名称', (m === null || m === void 0 ? void 0 : m.name) || '', '如 deepseek-chat'],
            ['model', '模型ID', (m === null || m === void 0 ? void 0 : m.model) || '', '如 deepseek-chat'],
            ['baseUrl', 'Base URL', (m === null || m === void 0 ? void 0 : m.baseUrl) || '', '如 https://api.deepseek.com/v1'],
            ['apiKey', 'API Key', (m === null || m === void 0 ? void 0 : m.apiKey) || '', ''],
            ['context_limit', '上下文限制', (m === null || m === void 0 ? void 0 : m.context_limit) ? String(m.context_limit) : '', '如 128000'],
            ['temperature', 'Temperature', (m === null || m === void 0 ? void 0 : m.temperature) !== undefined ? String(m.temperature) : '', ''],
            ['max_tokens', 'max_tokens（可选）', (m === null || m === void 0 ? void 0 : m.max_tokens) ? String(m.max_tokens) : '', '留空用 API 默认']
        ];
        for (const [key, label, value, ph] of fields) {
            const row = el('div', { class: 'cbhcli-form-row' });
            row.appendChild(el('label', { class: 'cbhcli-label' }, label));
            const input = el('input', { class: 'cbhcli-input', value, placeholder: ph || '' });
            input.dataset['key'] = key;
            row.appendChild(input);
            wrap.appendChild(row);
        }
        // vision
        const visionRow = el('div', { class: 'cbhcli-form-row' });
        visionRow.appendChild(el('label', { class: 'cbhcli-label' }, '视觉模型'));
        const vision = el('input', { type: 'checkbox', checked: !!(m === null || m === void 0 ? void 0 : m.vision) });
        vision.dataset['key'] = 'vision';
        visionRow.appendChild(vision);
        wrap.appendChild(visionRow);
        // thinking
        const thinkRow = el('div', { class: 'cbhcli-form-row' });
        thinkRow.appendChild(el('label', { class: 'cbhcli-label' }, '思考模式'));
        const think = el('select', { class: 'cbhcli-select' });
        for (const [v, label] of [['', '（不传，默认）'], ['true', '开启'], ['false', '关闭']]) {
            const opt = el('option', { value: v }, label);
            if (String(m === null || m === void 0 ? void 0 : m.thinking) === v) {
                opt.selected = true;
            }
            think.appendChild(opt);
        }
        think.dataset['key'] = 'thinking';
        thinkRow.appendChild(think);
        wrap.appendChild(thinkRow);
        // reasoning_effort
        const effortRow = el('div', { class: 'cbhcli-form-row' });
        effortRow.appendChild(el('label', { class: 'cbhcli-label' }, '推理强度'));
        const effort = el('select', { class: 'cbhcli-select' });
        for (const v of ['', 'minimum', 'low', 'medium', 'high', 'xhigh', 'max']) {
            const opt = el('option', { value: v }, v || '（不传）');
            if (String(m === null || m === void 0 ? void 0 : m.reasoning_effort) === v) {
                opt.selected = true;
            }
            effort.appendChild(opt);
        }
        effort.dataset['key'] = 'reasoning_effort';
        effortRow.appendChild(effort);
        wrap.appendChild(effortRow);
        // thinking=off 时禁用 effort
        const sync = () => {
            const off = think.value === 'false';
            effort.disabled = off;
            if (off) {
                effort.value = '';
            }
        };
        think.addEventListener('change', sync);
        sync();
        return wrap;
    }
    _collectForm(form) {
        const data = {};
        form.querySelectorAll('[data-key]').forEach(input => {
            const key = input.dataset['key'];
            if (input.type === 'checkbox') {
                data[key] = input.checked;
            }
            else if (key === 'context_limit' || key === 'temperature' || key === 'max_tokens') {
                const v = input.value.trim();
                data[key] = v === '' ? (key === 'temperature' ? 0.7 : undefined) : Number(v);
            }
            else if (key === 'thinking') {
                data[key] = input.value === '' ? null : input.value === 'true';
            }
            else if (key === 'reasoning_effort') {
                data[key] = input.value || null;
            }
            else {
                data[key] = input.value.trim();
            }
        });
        if (data['thinking'] === false) {
            data['reasoning_effort'] = null;
        }
        return data;
    }
    // ------------------------------------------------------------------
    //  MCP 服务器（实用级）
    // ------------------------------------------------------------------
    async _buildMcpSection() {
        const group = this._section('🔌 MCP 服务器', '外部工具服务器（Model Context Protocol）', 'mcp');
        const agent = encodeURIComponent(this._ctx.getAgent());
        let servers = [];
        try {
            const data = await apiGet(`agents/${agent}/mcp`);
            servers = (data === null || data === void 0 ? void 0 : data.servers) || [];
        }
        catch (_a) {
            servers = [];
        }
        group.appendChild(el('button', {
            class: 'cbhcli-btn cbhcli-btn-small',
            onclick: () => this._addMcpServerDialog(agent)
        }, '✚ 添加服务器'));
        if (servers.length === 0) {
            group.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无 MCP 服务器'));
            return group;
        }
        for (const s of servers) {
            const card = el('div', { class: 'cbhcli-mcp-server' });
            const head = el('div', { class: 'cbhcli-mcp-head' });
            head.appendChild(el('span', { class: 'cbhcli-mcp-name' }, `🔌 ${s.name}${s.connected ? '' : '（未连接）'}`));
            const actions = el('div', { class: 'cbhcli-mcp-actions' });
            actions.appendChild(el('button', {
                class: 'cbhcli-btn cbhcli-btn-small',
                onclick: async () => {
                    try {
                        await apiPost(`agents/${agent}/mcp/${encodeURIComponent(s.name)}/refresh`);
                        this._ctx.notify();
                        void this.refresh();
                    }
                    catch (e) {
                        alert(`刷新失败: ${e instanceof Error ? e.message : e}`);
                    }
                }
            }, '🔄 刷新'));
            actions.appendChild(el('button', {
                class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger',
                onclick: async () => {
                    if (!confirm(`删除 MCP 服务器 '${s.name}'？`)) {
                        return;
                    }
                    try {
                        await apiDelete(`agents/${agent}/mcp/${encodeURIComponent(s.name)}`);
                        this._ctx.notify();
                        void this.refresh();
                    }
                    catch (e) {
                        alert(`删除失败: ${e instanceof Error ? e.message : e}`);
                    }
                }
            }, '🗑 删除'));
            head.appendChild(actions);
            card.appendChild(head);
            let tools = [];
            try {
                const td = await apiGet(`agents/${agent}/mcp/${encodeURIComponent(s.name)}/tools`);
                tools = (td === null || td === void 0 ? void 0 : td.tools) || [];
            }
            catch (_b) {
                tools = [];
            }
            if (tools.length === 0) {
                card.appendChild(el('div', { class: 'cbhcli-empty' }, '（无工具）'));
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
                card.appendChild(row);
            }
            group.appendChild(card);
        }
        return group;
    }
    _addMcpServerDialog(agent) {
        const nameInput = el('input', { class: 'cbhcli-input', placeholder: '服务器名称（如 map）' });
        const urlInput = el('input', { class: 'cbhcli-input', placeholder: '服务器 URL（http://... / sse 地址）' });
        const body = el('div', { class: 'cbhcli-form' });
        body.appendChild(el('div', { class: 'cbhcli-form-label' }, '名称'));
        body.appendChild(nameInput);
        body.appendChild(el('div', { class: 'cbhcli-form-label' }, 'URL'));
        body.appendChild(urlInput);
        this._showDialog('✚ 添加 MCP 服务器', body, async () => {
            const name = nameInput.value.trim();
            const url = urlInput.value.trim();
            if (!name || !url) {
                throw new Error('名称和 URL 不能为空');
            }
            await apiPost(`agents/${agent}/mcp`, { name, url });
            this._ctx.notify();
            void this.refresh();
        });
    }
    // ------------------------------------------------------------------
    //  知识库（v0.2.15 新增：列表 + 添加 + 删除 + 重建索引 + 向量状态）
    // ------------------------------------------------------------------
    async _buildKnowledgeSection() {
        const agent = encodeURIComponent(this._ctx.getAgent());
        const group = this._section('📚 知识库', '添加文档建立向量索引，供 knowledge_base 工具检索', 'knowledge');
        let files = [];
        let vectorEnabled = false;
        try {
            const data = await apiGet(`agents/${agent}/knowledge`);
            files = (data === null || data === void 0 ? void 0 : data.files) || [];
            vectorEnabled = !!(data === null || data === void 0 ? void 0 : data.vector_enabled);
        }
        catch (_a) {
            files = [];
        }
        // 向量状态
        group.appendChild(el('div', { class: 'cbhcli-kb-status' + (vectorEnabled ? ' on' : '') }, vectorEnabled ? '🟢 向量索引已启用' : '⚪ 向量未启用（请先在 CLI/web 配置嵌入模型）'));
        // 操作按钮
        const actions = el('div', { class: 'cbhcli-model-actions' });
        actions.appendChild(el('button', {
            class: 'cbhcli-btn cbhcli-btn-small',
            onclick: () => this._addKnowledgeDialog(agent)
        }, '✚ 添加文件'));
        actions.appendChild(el('button', {
            class: 'cbhcli-btn cbhcli-btn-small',
            onclick: async () => {
                try {
                    const r = await apiPost(`agents/${agent}/knowledge/reindex`);
                    alert((r === null || r === void 0 ? void 0 : r.message) || '已重建索引');
                    void this.refresh();
                }
                catch (e) {
                    alert(`重建索引失败: ${e instanceof Error ? e.message : e}`);
                }
            }
        }, '🔄 重建索引'));
        group.appendChild(actions);
        // 文件列表
        if (files.length === 0) {
            group.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无知识库文件'));
            return group;
        }
        for (const f of files) {
            const name = typeof f === 'string' ? f : (f.name || '');
            const size = typeof f === 'object' && f.size != null ? this._fmtSize(f.size) : '';
            const item = el('div', { class: 'cbhcli-kb-item' });
            const nameEl = el('span', { class: 'cbhcli-kb-name' }, `📄 ${name}${size ? '（' + size + '）' : ''}`);
            nameEl.title = (typeof f === 'object' && f.path) || name;
            item.appendChild(nameEl);
            item.appendChild(el('button', {
                class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger',
                onclick: async () => {
                    if (!confirm(`从知识库删除 '${name}'？`)) {
                        return;
                    }
                    try {
                        await apiDelete(`agents/${agent}/knowledge/${encodeURIComponent(name)}`);
                        void this.refresh();
                    }
                    catch (e) {
                        alert(`删除失败: ${e instanceof Error ? e.message : e}`);
                    }
                }
            }, '删除'));
            group.appendChild(item);
        }
        return group;
    }
    /** 字节数 → 可读大小。 */
    _fmtSize(n) {
        if (n < 1024) {
            return `${n} B`;
        }
        if (n < 1024 * 1024) {
            return `${(n / 1024).toFixed(1)} KB`;
        }
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }
    _addKnowledgeDialog(agent) {
        const pathInput = el('input', {
            class: 'cbhcli-input',
            placeholder: '文件绝对路径（如 /home/.../doc.md）'
        });
        const body = el('div', { class: 'cbhcli-form' });
        body.appendChild(el('div', { class: 'cbhcli-form-label' }, '文件路径'));
        body.appendChild(pathInput);
        body.appendChild(el('div', { class: 'cbhcli-settings-desc' }, '支持 md/txt/pdf 等；文件将复制到知识库并建立向量索引'));
        this._showDialog('✚ 添加知识库文件', body, async () => {
            const filePath = pathInput.value.trim();
            if (!filePath) {
                throw new Error('文件路径不能为空');
            }
            await apiPost(`agents/${agent}/knowledge`, { file_path: filePath });
            this._ctx.notify();
            void this.refresh();
        });
    }
    // ------------------------------------------------------------------
    //  Agent 链条（实用级：列表 + 树 + 激活/取消）
    // ------------------------------------------------------------------
    async _buildChainSection() {
        var _a, _b, _c;
        const group = this._section('🔗 Agent 链条', '多 Agent 调用编排（新建/编辑请用 CLI /chain 或 web）', 'chains');
        const agentName = this._ctx.getAgent();
        const modelName = this._ctx.getModel();
        let chains = [];
        try {
            const data = await apiGet('chains');
            chains = (data === null || data === void 0 ? void 0 : data.chains) || [];
        }
        catch (_d) {
            chains = [];
        }
        let activeChain = null;
        try {
            const status = await apiGet(`chat/status?agent_name=${encodeURIComponent(agentName)}` +
                `&model_name=${encodeURIComponent(modelName)}`);
            activeChain = (status === null || status === void 0 ? void 0 : status.active_chain) || null;
        }
        catch (_e) {
            activeChain = null;
        }
        if (chains.length === 0) {
            group.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无链条（可用 CLI /chain add 或 web 创建）'));
            return group;
        }
        for (const c of chains) {
            const rootAgent = (_c = (_b = (_a = (c.levels || [])[0]) === null || _a === void 0 ? void 0 : _a.agents) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.name;
            const isRoot = rootAgent === agentName;
            const card = el('div', { class: 'cbhcli-chain-card' + (activeChain === c.name ? ' active' : '') });
            const head = el('div', { class: 'cbhcli-chain-head' });
            head.appendChild(el('span', { class: 'cbhcli-chain-name' }, `🔗 ${c.name}${c.valid === false ? '（无效）' : ''}${activeChain === c.name ? '（已激活）' : ''}`));
            if (activeChain === c.name) {
                head.appendChild(el('button', {
                    class: 'cbhcli-btn cbhcli-btn-small',
                    onclick: async () => {
                        try {
                            await apiPost('chat/off-chain', { agent_name: agentName, model_name: modelName });
                            this._ctx.notify();
                            void this.refresh();
                        }
                        catch (e) {
                            alert(`取消失败: ${e instanceof Error ? e.message : e}`);
                        }
                    }
                }, '取消激活'));
            }
            else if (isRoot) {
                head.appendChild(el('button', {
                    class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-primary',
                    onclick: async () => {
                        try {
                            await apiPost('chat/use-chain', {
                                agent_name: agentName, model_name: modelName, chain_name: c.name
                            });
                            this._ctx.notify();
                            void this.refresh();
                        }
                        catch (e) {
                            alert(`激活失败: ${e instanceof Error ? e.message : e}`);
                        }
                    }
                }, '激活'));
            }
            card.appendChild(head);
            if (c.description) {
                card.appendChild(el('div', { class: 'cbhcli-chain-desc' }, c.description));
            }
            const tree = el('div', { class: 'cbhcli-chain-tree' });
            (c.levels || []).forEach((level, i) => {
                (level.agents || []).forEach((a, j) => {
                    const indent = '  '.repeat(i);
                    const conn = i === 0 ? '' : (j === level.agents.length - 1 ? '└── ' : '├── ');
                    tree.appendChild(el('div', { class: 'cbhcli-chain-node' }, `${indent}${conn}${a.name}${a.description ? ` - ${a.description}` : ''}`));
                });
            });
            card.appendChild(tree);
            if (!isRoot && activeChain !== c.name) {
                card.appendChild(el('div', { class: 'cbhcli-chain-note' }, `元 Agent 是 '${rootAgent}'，需切换到该 Agent 才能激活`));
            }
            group.appendChild(card);
        }
        return group;
    }
    // ------------------------------------------------------------------
    //  通用
    // ------------------------------------------------------------------
    /** 分区容器；传 key 则可折叠（点击标题行收起/展开，状态跨 refresh 保留，v0.2.15）。 */
    _section(title, desc, key) {
        const group = el('div', { class: 'cbhcli-settings-group' + (key ? ' collapsible' : '') });
        const head = el('div', { class: 'cbhcli-section-head' });
        let chevron = null;
        if (key) {
            const collapsed = !!this._collapsed[key];
            if (collapsed) {
                group.classList.add('collapsed');
            }
            chevron = el('span', { class: 'cbhcli-section-chevron' }, collapsed ? '▸' : '▾');
            head.appendChild(chevron);
        }
        head.appendChild(el('div', { class: 'cbhcli-settings-title' }, title));
        group.appendChild(head);
        if (desc) {
            group.appendChild(el('div', { class: 'cbhcli-settings-desc' }, desc));
        }
        if (key) {
            head.addEventListener('click', () => {
                this._collapsed[key] = !this._collapsed[key];
                group.classList.toggle('collapsed', this._collapsed[key]);
                if (chevron) {
                    chevron.textContent = this._collapsed[key] ? '▸' : '▾';
                }
            });
        }
        return group;
    }
    _showDialog(title, body, onOk) {
        const overlay = el('div', { class: 'cbhcli-dialog-overlay' });
        const dlg = el('div', { class: 'cbhcli-dialog' });
        dlg.appendChild(el('div', { class: 'cbhcli-dialog-title' }, title));
        dlg.appendChild(body);
        const btns = el('div', { class: 'cbhcli-dialog-actions' });
        const close = () => overlay.remove();
        btns.appendChild(el('button', { class: 'cbhcli-btn', onclick: close }, '取消'));
        btns.appendChild(el('button', {
            class: 'cbhcli-btn cbhcli-btn-primary',
            onclick: async () => {
                try {
                    await onOk();
                    close();
                }
                catch (err) {
                    alert(`操作失败: ${err instanceof Error ? err.message : err}`);
                }
            }
        }, '确定'));
        dlg.appendChild(btns);
        overlay.appendChild(dlg);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                close();
            }
        });
    }
}

/**
 * 配置面板（v0.2 重构，仿 cbhcli Web 管理界面）。
 *
 * 分区：模型管理 / 备用模型（可增删排序）/ 权限模式 / 历史会话。
 * Agent 与当前模型的选择只在主面板顶栏，这里不再重复显示。
 */

import { Widget } from '@lumino/widgets';
import { apiGet, apiPost, apiPut, apiDelete } from '../api';

// ---------------------------------------------------------------------------
//  类型 & 工具函数
// ---------------------------------------------------------------------------

interface ModelInfo {
  name: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  vision?: boolean;
  thinking?: boolean | string | null;
  reasoning_effort?: string | null;
  max_tokens?: number | null;
  context_limit?: number;
  temperature?: number;
  [k: string]: any;
}

interface SettingsCtx {
  getAgent: () => string;
  getModel: () => string;
  notify: () => void;
}

function el(tag: string, attrs: Record<string, any> = {}, ...children: any[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') {
      node.className = v;
    } else if (k === 'text') {
      node.textContent = v;
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'checked' || k === 'disabled') {
      if (v) {
        node.setAttribute(k, '');
      }
    } else if (v !== null && v !== undefined) {
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
  private _root!: HTMLElement;

  constructor(private _ctx: SettingsCtx) {
    super();
    this.addClass('cbhcli-settings');
    this._root = el('div', { class: 'cbhcli-settings-root' });
    this.node.appendChild(this._root);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this._root.innerHTML = '';
    // 模型管理
    this._root.appendChild(await this._buildModelsSection());
    // 备用模型
    this._root.appendChild(await this._buildFallbackSection());
    // MCP 服务器（实用级：列表+工具开关+刷新/删除+添加）
    this._root.appendChild(await this._buildMcpSection());
    // Agent 链条（实用级：列表+树+激活/取消）
    this._root.appendChild(await this._buildChainSection());
    // 权限模式
    this._root.appendChild(await this._buildPermissionsSection());
    // 历史会话
    this._root.appendChild(await this._buildHistorySection());
  }

  // ------------------------------------------------------------------
  //  模型管理
  // ------------------------------------------------------------------

  private async _buildModelsSection(): Promise<HTMLElement> {
    const group = this._section('🧠 模型管理');
    let models: ModelInfo[] = [];
    try {
      const data = await apiGet<{ models?: ModelInfo[] }>('models');
      models = data?.models || [];
    } catch {
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
      const tags: string[] = [];
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
      info.appendChild(
        el('div', { class: 'cbhcli-model-name' }, `${m.name === current ? '● ' : ''}${m.name}  ${tags.join(' ')}`)
      );
      info.appendChild(
        el('div', { class: 'cbhcli-model-detail' }, `${m.model || ''}${m.baseUrl ? ' @ ' + m.baseUrl : ''}`)
      );
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
    group.appendChild(
      el('button', { class: 'cbhcli-btn cbhcli-btn-primary', onclick: () => this._addModel() }, '➕ 添加模型')
    );
    return group;
  }

  // ------------------------------------------------------------------
  //  备用模型（可配置）
  // ------------------------------------------------------------------

  private async _buildFallbackSection(): Promise<HTMLElement> {
    const group = this._section('🔁 备用模型', '主模型异常时按顺序自动切换；视觉模型同理（image 工具）');
    let data: any = { main: [], vision: [], available_models: [] };
    try {
      data = await apiGet('fallback');
    } catch {
      /* keep empty */
    }
    group.appendChild(this._fallbackCategory('main', '🧠 主模型备用', data));
    group.appendChild(this._fallbackCategory('vision', '👁 视觉模型备用', data));
    return group;
  }

  private _fallbackCategory(cat: 'main' | 'vision', title: string, data: any): HTMLElement {
    const list: string[] = data[cat] || [];
    const available: { name: string; vision?: boolean }[] = data.available_models || [];
    const wrap = el('div', { class: 'cbhcli-fb-cat' });
    wrap.appendChild(el('div', { class: 'cbhcli-fb-title' }, title));

    if (list.length === 0) {
      wrap.appendChild(el('div', { class: 'cbhcli-empty' }, '（未配置）'));
    } else {
      const listEl = el('div', { class: 'cbhcli-fb-list' });
      list.forEach((name, i) => {
        const configured = available.some(x => x.name === name);
        const item = el('div', { class: 'cbhcli-fb-item' });
        item.appendChild(el('span', { class: 'cbhcli-fb-idx' }, String(i + 1)));
        item.appendChild(el('span', { class: 'cbhcli-fb-name' }, name));
        item.appendChild(
          el('span', { class: 'cbhcli-tag ' + (configured ? 'green' : 'red') }, configured ? '已配置' : '未配置')
        );
        const btns = el('div', { class: 'cbhcli-fb-btns' });
        btns.appendChild(
          el('button', {
            class: 'cbhcli-btn cbhcli-btn-small', title: '上移', disabled: i === 0 ? true : null,
            onclick: () => this._reorderFallback(cat, list, i, i - 1)
          }, '↑')
        );
        btns.appendChild(
          el('button', {
            class: 'cbhcli-btn cbhcli-btn-small', title: '下移', disabled: i === list.length - 1 ? true : null,
            onclick: () => this._reorderFallback(cat, list, i, i + 1)
          }, '↓')
        );
        btns.appendChild(
          el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._removeFallback(cat, name) }, '移除')
        );
        item.appendChild(btns);
        listEl.appendChild(item);
      });
      wrap.appendChild(listEl);
    }

    // 添加行
    const sel = el('select', { class: 'cbhcli-select cbhcli-fb-select' }) as HTMLSelectElement;
    const candidates = available.filter(x => !list.includes(x.name) && (cat === 'main' || x.vision));
    sel.appendChild(el('option', { value: '' }, '选择模型…'));
    for (const c of candidates) {
      sel.appendChild(el('option', { value: c.name }, c.name + (c.vision ? ' 👁' : '')));
    }
    const row = el('div', { class: 'cbhcli-fb-addrow' });
    row.appendChild(sel);
    row.appendChild(
      el('button', {
        class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-primary',
        onclick: () => this._addFallback(cat, sel.value)
      }, '添加')
    );
    if (list.length > 0) {
      row.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._clearFallback(cat) }, '清空'));
    }
    wrap.appendChild(row);
    return wrap;
  }

  private async _addFallback(cat: string, name: string): Promise<void> {
    if (!name) {
      alert('请选择模型');
      return;
    }
    try {
      await apiPost('fallback', { category: cat, model_name: name });
      this.refresh();
    } catch (err) {
      alert(`添加失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _removeFallback(cat: string, name: string): Promise<void> {
    try {
      await apiDelete(`fallback/${cat}/${encodeURIComponent(name)}`);
      this.refresh();
    } catch (err) {
      alert(`移除失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _clearFallback(cat: string): Promise<void> {
    if (!confirm(`确定清空 ${cat} 备用列表吗？`)) {
      return;
    }
    try {
      await apiDelete(`fallback/clear/${cat}`);
      this.refresh();
    } catch (err) {
      alert(`清空失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _reorderFallback(cat: string, list: string[], from: number, to: number): Promise<void> {
    if (to < 0 || to >= list.length) {
      return;
    }
    const order = [...list];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    try {
      await apiPut(`fallback/reorder/${cat}`, { order });
      this.refresh();
    } catch (err) {
      alert(`排序失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ------------------------------------------------------------------
  //  权限模式
  // ------------------------------------------------------------------

  private async _buildPermissionsSection(): Promise<HTMLElement> {
    const group = this._section('🛡️ 权限模式', '控制工具调用的确认策略');
    let perms: any = { mode: 'standard', modes: [], rules: {} };
    try {
      perms = await apiGet('permissions');
    } catch {
      /* keep default */
    }
    const row = el('div', { class: 'cbhcli-settings-row' });
    const sel = el('select', { class: 'cbhcli-select' }) as HTMLSelectElement;
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
    const cur = (perms.modes || []).find((m: any) => m.id === perms.mode);
    if (cur?.desc) {
      group.appendChild(el('div', { class: 'cbhcli-perm-desc' }, cur.desc));
    }

    // 用户规则展示
    const rules = perms.rules || {};
    const ruleWrap = el('div', { class: 'cbhcli-perm-rules' });
    let hasRule = false;
    for (const cat of ['deny', 'ask', 'allow']) {
      const list = (rules[cat] || []) as string[];
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

  private async _setPermissionMode(mode: string): Promise<void> {
    try {
      await apiPost('permissions/mode', { mode });
      this.refresh();
    } catch (err) {
      alert(`设置失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ------------------------------------------------------------------
  //  历史会话
  // ------------------------------------------------------------------

  private async _buildHistorySection(): Promise<HTMLElement> {
    const group = this._section('🕘 历史会话');
    const agent = this._ctx.getAgent();
    let sessions: any[] = [];
    try {
      const data = await apiGet<{ sessions?: any[] }>(`agents/${encodeURIComponent(agent)}/history`);
      sessions = data?.sessions || [];
    } catch {
      sessions = [];
    }
    if (sessions.length === 0) {
      group.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无历史会话'));
      return group;
    }
    const list = el('div', { class: 'cbhcli-history-list' });
    for (const s of sessions.slice(0, 20)) {
      const item = el('div', { class: 'cbhcli-history-item' });
      const label = `${s.filename || s.id || ''} · ${s.message_count || 0} 条`;
      item.appendChild(el('span', { class: 'cbhcli-history-label' }, label));
      const btns = el('div', { class: 'cbhcli-model-actions' });
      btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small', onclick: () => this._loadHistory(s.filename) }, '恢复'));
      btns.appendChild(el('button', { class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-danger', onclick: () => this._deleteHistory(s.filename) }, '删除'));
      item.appendChild(btns);
      list.appendChild(item);
    }
    group.appendChild(list);
    return group;
  }

  private async _loadHistory(filename: string): Promise<void> {
    try {
      await apiPost('chat/load', {
        agent_name: this._ctx.getAgent(),
        model_name: this._ctx.getModel(),
        filename
      });
      this._ctx.notify();
    } catch (err) {
      alert(`恢复失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _deleteHistory(filename: string): Promise<void> {
    if (!confirm(`删除历史会话 '${filename}'？`)) {
      return;
    }
    try {
      await apiDelete(`agents/${encodeURIComponent(this._ctx.getAgent())}/history/${encodeURIComponent(filename)}`);
      this.refresh();
    } catch (err) {
      alert(`删除失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ------------------------------------------------------------------
  //  模型操作
  // ------------------------------------------------------------------

  private async _selectModel(name: string): Promise<void> {
    try {
      await apiPost('models/select', { model_name: name });
      this._ctx.notify();
      this.refresh();
    } catch (err) {
      alert(`切换失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private _addModel(): void {
    const form = this._modelForm(null);
    this._showDialog('添加模型', form, async () => {
      const data = this._collectForm(form);
      await apiPost('models', data);
      this.refresh();
      this._ctx.notify();
    });
  }

  private _editModel(m: ModelInfo): void {
    const form = this._modelForm(m);
    this._showDialog('编辑模型', form, async () => {
      const data = this._collectForm(form);
      await apiPut(`models/${encodeURIComponent(m.name)}`, data);
      this.refresh();
      this._ctx.notify();
    });
  }

  private async _deleteModel(name: string): Promise<void> {
    if (!confirm(`确认删除模型 '${name}'？`)) {
      return;
    }
    try {
      await apiDelete(`models/${encodeURIComponent(name)}`);
      this.refresh();
      this._ctx.notify();
    } catch (err) {
      alert(`删除失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  private _modelForm(m: ModelInfo | null): HTMLElement {
    const wrap = el('div', { class: 'cbhcli-form' });
    const fields: [string, string, string, string?][] = [
      ['name', '名称', m?.name || '', '如 deepseek-chat'],
      ['model', '模型ID', m?.model || '', '如 deepseek-chat'],
      ['baseUrl', 'Base URL', m?.baseUrl || '', '如 https://api.deepseek.com/v1'],
      ['apiKey', 'API Key', m?.apiKey || '', ''],
      ['context_limit', '上下文限制', m?.context_limit ? String(m.context_limit) : '', '如 128000'],
      ['temperature', 'Temperature', m?.temperature !== undefined ? String(m.temperature) : '', ''],
      ['max_tokens', 'max_tokens（可选）', m?.max_tokens ? String(m.max_tokens) : '', '留空用 API 默认']
    ];
    for (const [key, label, value, ph] of fields) {
      const row = el('div', { class: 'cbhcli-form-row' });
      row.appendChild(el('label', { class: 'cbhcli-label' }, label));
      const input = el('input', { class: 'cbhcli-input', value, placeholder: ph || '' }) as HTMLInputElement;
      input.dataset['key'] = key;
      row.appendChild(input);
      wrap.appendChild(row);
    }
    // vision
    const visionRow = el('div', { class: 'cbhcli-form-row' });
    visionRow.appendChild(el('label', { class: 'cbhcli-label' }, '视觉模型'));
    const vision = el('input', { type: 'checkbox', checked: !!m?.vision }) as HTMLInputElement;
    vision.dataset['key'] = 'vision';
    visionRow.appendChild(vision);
    wrap.appendChild(visionRow);
    // thinking
    const thinkRow = el('div', { class: 'cbhcli-form-row' });
    thinkRow.appendChild(el('label', { class: 'cbhcli-label' }, '思考模式'));
    const think = el('select', { class: 'cbhcli-select' }) as HTMLSelectElement;
    for (const [v, label] of [['', '（不传，默认）'], ['true', '开启'], ['false', '关闭']]) {
      const opt = el('option', { value: v }, label) as HTMLOptionElement;
      if (String(m?.thinking) === v) {
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
    const effort = el('select', { class: 'cbhcli-select' }) as HTMLSelectElement;
    for (const v of ['', 'minimum', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const opt = el('option', { value: v }, v || '（不传）') as HTMLOptionElement;
      if (String(m?.reasoning_effort) === v) {
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

  private _collectForm(form: HTMLElement): Record<string, any> {
    const data: Record<string, any> = {};
    form.querySelectorAll<HTMLInputElement>('[data-key]').forEach(input => {
      const key = input.dataset['key']!;
      if (input.type === 'checkbox') {
        data[key] = input.checked;
      } else if (key === 'context_limit' || key === 'temperature' || key === 'max_tokens') {
        const v = input.value.trim();
        data[key] = v === '' ? (key === 'temperature' ? 0.7 : undefined) : Number(v);
      } else if (key === 'thinking') {
        data[key] = input.value === '' ? null : input.value === 'true';
      } else if (key === 'reasoning_effort') {
        data[key] = input.value || null;
      } else {
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

  private async _buildMcpSection(): Promise<HTMLElement> {
    const group = this._section('🔌 MCP 服务器', '外部工具服务器（Model Context Protocol）');
    const agent = encodeURIComponent(this._ctx.getAgent());
    let servers: any[] = [];
    try {
      const data = await apiGet<{ servers?: any[] }>(`agents/${agent}/mcp`);
      servers = data?.servers || [];
    } catch {
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
      head.appendChild(el('span', { class: 'cbhcli-mcp-name' },
        `🔌 ${s.name}${s.connected ? '' : '（未连接）'}`));
      const actions = el('div', { class: 'cbhcli-mcp-actions' });
      actions.appendChild(el('button', {
        class: 'cbhcli-btn cbhcli-btn-small',
        onclick: async () => {
          try {
            await apiPost(`agents/${agent}/mcp/${encodeURIComponent(s.name)}/refresh`);
            this._ctx.notify();
            void this.refresh();
          } catch (e) {
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
          } catch (e) {
            alert(`删除失败: ${e instanceof Error ? e.message : e}`);
          }
        }
      }, '🗑 删除'));
      head.appendChild(actions);
      card.appendChild(head);

      let tools: any[] = [];
      try {
        const td = await apiGet<{ tools?: any[] }>(
          `agents/${agent}/mcp/${encodeURIComponent(s.name)}/tools`);
        tools = td?.tools || [];
      } catch {
        tools = [];
      }
      if (tools.length === 0) {
        card.appendChild(el('div', { class: 'cbhcli-empty' }, '（无工具）'));
      }
      for (const t of tools) {
        const enabled = t.enabled !== false;
        const row = el('label', { class: 'cbhcli-check-row' + (enabled ? ' on' : '') });
        const box = el('input', { type: 'checkbox', checked: enabled }) as HTMLInputElement;
        box.addEventListener('change', () => {
          row.classList.toggle('on', box.checked);
          void apiPut(
            `agents/${agent}/mcp/${encodeURIComponent(s.name)}/tools/${encodeURIComponent(t.name)}`,
            { enable: box.checked }
          ).catch(() => {
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

  private _addMcpServerDialog(agent: string): void {
    const nameInput = el('input', { class: 'cbhcli-input', placeholder: '服务器名称（如 map）' }) as HTMLInputElement;
    const urlInput = el('input', { class: 'cbhcli-input', placeholder: '服务器 URL（http://... / sse 地址）' }) as HTMLInputElement;
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
  //  Agent 链条（实用级：列表 + 树 + 激活/取消）
  // ------------------------------------------------------------------

  private async _buildChainSection(): Promise<HTMLElement> {
    const group = this._section('🔗 Agent 链条', '多 Agent 调用编排（新建/编辑请用 CLI /chain 或 web）');
    const agentName = this._ctx.getAgent();
    const modelName = this._ctx.getModel();
    let chains: any[] = [];
    try {
      const data = await apiGet<{ chains?: any[] }>('chains');
      chains = data?.chains || [];
    } catch {
      chains = [];
    }
    let activeChain: string | null = null;
    try {
      const status = await apiGet<{ active_chain?: string | null }>(
        `chat/status?agent_name=${encodeURIComponent(agentName)}` +
        `&model_name=${encodeURIComponent(modelName)}`);
      activeChain = status?.active_chain || null;
    } catch {
      activeChain = null;
    }

    if (chains.length === 0) {
      group.appendChild(el('div', { class: 'cbhcli-empty' }, '暂无链条（可用 CLI /chain add 或 web 创建）'));
      return group;
    }

    for (const c of chains) {
      const rootAgent = (c.levels || [])[0]?.agents?.[0]?.name;
      const isRoot = rootAgent === agentName;
      const card = el('div', { class: 'cbhcli-chain-card' + (activeChain === c.name ? ' active' : '') });
      const head = el('div', { class: 'cbhcli-chain-head' });
      head.appendChild(el('span', { class: 'cbhcli-chain-name' },
        `🔗 ${c.name}${c.valid === false ? '（无效）' : ''}${activeChain === c.name ? '（已激活）' : ''}`));
      if (activeChain === c.name) {
        head.appendChild(el('button', {
          class: 'cbhcli-btn cbhcli-btn-small',
          onclick: async () => {
            try {
              await apiPost('chat/off-chain', { agent_name: agentName, model_name: modelName });
              this._ctx.notify();
              void this.refresh();
            } catch (e) {
              alert(`取消失败: ${e instanceof Error ? e.message : e}`);
            }
          }
        }, '取消激活'));
      } else if (isRoot) {
        head.appendChild(el('button', {
          class: 'cbhcli-btn cbhcli-btn-small cbhcli-btn-primary',
          onclick: async () => {
            try {
              await apiPost('chat/use-chain', {
                agent_name: agentName, model_name: modelName, chain_name: c.name
              });
              this._ctx.notify();
              void this.refresh();
            } catch (e) {
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
      (c.levels || []).forEach((level: any, i: number) => {
        (level.agents || []).forEach((a: any, j: number) => {
          const indent = '  '.repeat(i);
          const conn = i === 0 ? '' : (j === level.agents.length - 1 ? '└── ' : '├── ');
          tree.appendChild(el('div', { class: 'cbhcli-chain-node' },
            `${indent}${conn}${a.name}${a.description ? ` - ${a.description}` : ''}`));
        });
      });
      card.appendChild(tree);
      if (!isRoot && activeChain !== c.name) {
        card.appendChild(el('div', { class: 'cbhcli-chain-note' },
          `元 Agent 是 '${rootAgent}'，需切换到该 Agent 才能激活`));
      }
      group.appendChild(card);
    }
    return group;
  }

  // ------------------------------------------------------------------
  //  通用
  // ------------------------------------------------------------------

  private _section(title: string, desc?: string): HTMLElement {
    const group = el('div', { class: 'cbhcli-settings-group' });
    group.appendChild(el('div', { class: 'cbhcli-settings-title' }, title));
    if (desc) {
      group.appendChild(el('div', { class: 'cbhcli-settings-desc' }, desc));
    }
    return group;
  }

  private _showDialog(title: string, body: HTMLElement, onOk: () => Promise<void>): void {
    const overlay = el('div', { class: 'cbhcli-dialog-overlay' });
    const dlg = el('div', { class: 'cbhcli-dialog' });
    dlg.appendChild(el('div', { class: 'cbhcli-dialog-title' }, title));
    dlg.appendChild(body);
    const btns = el('div', { class: 'cbhcli-dialog-actions' });
    const close = () => overlay.remove();
    btns.appendChild(el('button', { class: 'cbhcli-btn', onclick: close }, '取消'));
    btns.appendChild(
      el('button', {
        class: 'cbhcli-btn cbhcli-btn-primary',
        onclick: async () => {
          try {
            await onOk();
            close();
          } catch (err) {
            alert(`操作失败: ${err instanceof Error ? err.message : err}`);
          }
        }
      }, '确定')
    );
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

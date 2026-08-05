/**
 * Notebook 集成客户端。
 *
 * 职责：
 * 1. 轮询后端 UI 任务队列（/notebook/pending），获取 Agent 发起的 notebook 操作；
 * 2. 在前端执行实际操作（选中识别 / cell 编辑 / 内核执行 / 文件操作）；
 * 3. 回传执行结果（/notebook/result）给后端 Agent。
 *
 * ⚠️ 本模块只操作 notebook/文件内容与内核，不注册任何键盘快捷键。
 */
import { NotebookActions } from '@jupyterlab/notebook';
import { CodeCell } from '@jupyterlab/cells';
import { OutputArea } from '@jupyterlab/outputarea';
import { apiGet, apiPost } from '../api';
// ---------------------------------------------------------------------------
//  工具函数
// ---------------------------------------------------------------------------
function fail(error) {
    return { success: false, output: '', error };
}
function ok(output, data = {}) {
    return { success: true, output, error: '', data };
}
// ---------------------------------------------------------------------------
//  Notebook 客户端
// ---------------------------------------------------------------------------
export class NotebookClient {
    constructor(_app, _tracker) {
        this._app = _app;
        this._tracker = _tracker;
        this._timer = null;
        this._polling = false;
    }
    /** 启动 UI 任务轮询（200ms 间隔）。 */
    start() {
        if (this._timer !== null) {
            return;
        }
        this._timer = window.setInterval(() => void this._poll(), 200);
    }
    /** 停止轮询。 */
    stop() {
        if (this._timer !== null) {
            window.clearInterval(this._timer);
            this._timer = null;
        }
    }
    // ------------------------------------------------------------------
    //  实时选区上下文（需求8）
    //  优先级（解决"残留旧选区"）：最近聚焦编辑器 > notebook 活动 cell > 整 cell 选中
    //  读取的是编辑器内存内容（sharedModel），无需保存即可实时识别。
    // ------------------------------------------------------------------
    /**
     * 实时选区检测。
     *
     * 优先取「最近聚焦/活动」的编辑器选区，避免返回其他 cell 的残留旧选区：
     *  1. 当前聚焦的文件编辑器文本选区
     *  2. notebook 活动 cell 的文本选区
     *  3. 其余文件编辑器的文本选区
     *  4. notebook 选中 cell 的整体内容（空/非空均可）
     *  5. 兜底：任意编辑器的文本选区
     */
    getCurrentSelectionContext() {
        try {
            const nb = this._currentNotebook();
            const cw = this._app.shell.currentWidget;
            // 1. 当前聚焦的是文件编辑器 → 优先其选区，其次光标位置
            if (this._isFileEditorWidget(cw)) {
                const ctx = this._fileEditorSelectionCtx(cw);
                if (ctx) {
                    return ctx;
                }
                const cur = this._fileEditorCursorCtx(cw);
                if (cur) {
                    return cur;
                }
            }
            // 2. notebook 活动 cell：文本选区 → 光标位置（仅编辑态；命令态走整 cell 选中）
            if (nb) {
                const activeCell = nb.content.activeCell;
                if (activeCell) {
                    const ctx = this._cellTextSelectionCtx(nb, activeCell);
                    if (ctx) {
                        return ctx;
                    }
                    if (this._isNbEditMode(nb)) {
                        const cur = this._cellCursorCtx(nb, activeCell);
                        if (cur) {
                            return cur;
                        }
                    }
                }
            }
            // 3. 其余文件编辑器的文本选区
            if (!this._isFileEditorWidget(cw)) {
                const fs = this._anyFileEditorSelection();
                if (fs) {
                    return fs;
                }
            }
            // 4. notebook 选中 cell 的整体内容（空/非空均可）
            if (nb) {
                const whole = this._notebookSelectedCells(nb);
                if (whole) {
                    return whole;
                }
            }
            // 5. 兜底：任意编辑器文本选区
            return this._anyEditorTextSelection();
        }
        catch (_a) {
            return null;
        }
    }
    /** widget 是否为文件编辑器（FileEditorWidget：content.editor 是 CodeMirrorEditor）。 */
    _isFileEditorWidget(w) {
        var _a, _b, _c;
        if (!w) {
            return false;
        }
        // 排除 notebook 面板（content.activeCell 存在）
        if (w.content && w.content.activeCell !== undefined) {
            return false;
        }
        const ed = (_b = (_a = w.content) === null || _a === void 0 ? void 0 : _a.editor) !== null && _b !== void 0 ? _b : w.editor;
        return (typeof ((_c = w.context) === null || _c === void 0 ? void 0 : _c.path) === 'string' &&
            !!ed &&
            typeof ed.getSelection === 'function');
    }
    /** 从 widget 取 CodeMirrorEditor（兼容 FileEditorWidget / FileEditor）。 */
    _cmEditorOf(w) {
        var _a, _b, _c;
        return (_c = (_b = (_a = w === null || w === void 0 ? void 0 : w.content) === null || _a === void 0 ? void 0 : _a.editor) !== null && _b !== void 0 ? _b : w === null || w === void 0 ? void 0 : w.editor) !== null && _c !== void 0 ? _c : null;
    }
    /** 由 CodeMirror 选区（0-based line/column）抽取文本 + 行列号（1-based）。 */
    _extractSelFromCm(editor) {
        var _a, _b, _c, _d;
        try {
            if (!editor || typeof editor.getSelection !== 'function') {
                return null;
            }
            const sel = editor.getSelection();
            if (!sel || !sel.start || !sel.end) {
                return null;
            }
            if (sel.start.line === sel.end.line && sel.start.column === sel.end.column) {
                return null;
            }
            const source = String((_d = (_c = (_b = (_a = editor.model) === null || _a === void 0 ? void 0 : _a.sharedModel) === null || _b === void 0 ? void 0 : _b.getSource) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : '');
            const lines = source.split('\n');
            let text;
            if (sel.start.line === sel.end.line) {
                text = (lines[sel.start.line] || '').slice(sel.start.column, sel.end.column);
            }
            else {
                const parts = [(lines[sel.start.line] || '').slice(sel.start.column)];
                for (let l = sel.start.line + 1; l < sel.end.line; l++) {
                    parts.push(lines[l] || '');
                }
                parts.push((lines[sel.end.line] || '').slice(0, sel.end.column));
                text = parts.join('\n');
            }
            if (!text.trim()) {
                return null;
            }
            return {
                text,
                startLine: sel.start.line + 1,
                endLine: sel.end.line + 1,
                startCol: sel.start.column + 1,
                endCol: sel.end.column
            };
        }
        catch (_e) {
            return null;
        }
    }
    /**
     * 提取光标位置（空选区，即 start==end）。返回 1-based line/col + 光标所在行内容。
     * 有实际选中范围时返回 null（交给选区逻辑处理）。
     */
    _extractCursorFromCm(editor) {
        var _a, _b, _c, _d;
        try {
            if (!editor || typeof editor.getSelection !== 'function') {
                return null;
            }
            const sel = editor.getSelection();
            if (!sel || !sel.start || !sel.end) {
                return null;
            }
            // 仅空选区（光标）；有选中范围返回 null
            if (!(sel.start.line === sel.end.line && sel.start.column === sel.end.column)) {
                return null;
            }
            const source = String((_d = (_c = (_b = (_a = editor.model) === null || _a === void 0 ? void 0 : _a.sharedModel) === null || _b === void 0 ? void 0 : _b.getSource) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : '');
            const lines = source.split('\n');
            const li = sel.start.line; // 0-based
            return {
                line: li + 1,
                col: sel.start.column + 1,
                lineText: lines[li] || ''
            };
        }
        catch (_e) {
            return null;
        }
    }
    /** notebook 是否处于编辑态（用户光标在 cell 代码中）。命令态下不识别光标，避免误报。 */
    _isNbEditMode(nb) {
        var _a, _b;
        try {
            const mode = nb.content.mode;
            if (mode === 'edit') {
                return true;
            }
            // 兜底：活动 cell 编辑器聚焦也算编辑态
            const ac = nb.content.activeCell;
            return !!((_b = (_a = ac === null || ac === void 0 ? void 0 : ac.editor) === null || _a === void 0 ? void 0 : _a.hasFocus) === null || _b === void 0 ? void 0 : _b.call(_a));
        }
        catch (_c) {
            return false;
        }
    }
    /** notebook 某 cell 的光标位置上下文（空选区，用户想在此插入代码）。 */
    _cellCursorCtx(nb, cellWidget) {
        const info = this._extractCursorFromCm(cellWidget === null || cellWidget === void 0 ? void 0 : cellWidget.editor);
        if (!info) {
            return null;
        }
        const cellIndex = this._cellIndexOf(nb, cellWidget);
        return {
            source: 'notebook',
            path: nb.context.path,
            location: `cell ${cellIndex} · 光标 L${info.line}:${info.col}`,
            text: info.lineText,
            cellIndex,
            startLine: info.line,
            endLine: info.line,
            startCol: info.col,
            endCol: info.col,
            isCursor: true
        };
    }
    /** 文件编辑器的光标位置上下文（空选区）。 */
    _fileEditorCursorCtx(w) {
        var _a;
        const info = this._extractCursorFromCm(this._cmEditorOf(w));
        if (!info) {
            return null;
        }
        return {
            source: 'file',
            path: String(((_a = w === null || w === void 0 ? void 0 : w.context) === null || _a === void 0 ? void 0 : _a.path) || ''),
            location: `光标 L${info.line}:${info.col}`,
            text: info.lineText,
            startLine: info.line,
            endLine: info.line,
            startCol: info.col,
            endCol: info.col,
            isCursor: true
        };
    }
    /** notebook 某 cell 的文本选区上下文（含列号）。 */
    _cellTextSelectionCtx(nb, cellWidget) {
        const info = this._extractSelFromCm(cellWidget === null || cellWidget === void 0 ? void 0 : cellWidget.editor);
        if (!info) {
            return null;
        }
        const cellIndex = this._cellIndexOf(nb, cellWidget);
        return {
            source: 'notebook',
            path: nb.context.path,
            location: `cell ${cellIndex} · L${info.startLine}:${info.startCol}-${info.endLine}:${info.endCol}`,
            text: info.text,
            cellIndex,
            startLine: info.startLine,
            endLine: info.endLine,
            startCol: info.startCol,
            endCol: info.endCol
        };
    }
    /** 文件编辑器的文本选区上下文（含列号）。 */
    _fileEditorSelectionCtx(w) {
        var _a;
        const info = this._extractSelFromCm(this._cmEditorOf(w));
        if (!info) {
            return null;
        }
        return {
            source: 'file',
            path: String(((_a = w === null || w === void 0 ? void 0 : w.context) === null || _a === void 0 ? void 0 : _a.path) || ''),
            location: `L${info.startLine}:${info.startCol}-${info.endLine}:${info.endCol}`,
            text: info.text,
            startLine: info.startLine,
            endLine: info.endLine,
            startCol: info.startCol,
            endCol: info.endCol
        };
    }
    /** 遍历主区文件编辑器，返回第一个有文本选区的。 */
    _anyFileEditorSelection() {
        try {
            for (const w of Array.from(this._app.shell.widgets('main'))) {
                if (this._isFileEditorWidget(w)) {
                    const ctx = this._fileEditorSelectionCtx(w);
                    if (ctx) {
                        return ctx;
                    }
                }
            }
        }
        catch (_a) {
            /* ignore */
        }
        return null;
    }
    /** 兜底：遍历页面所有 CodeMirror 编辑器，返回第一个有选区的（含列号）。 */
    _anyEditorTextSelection() {
        var _a, _b;
        try {
            const cmContents = document.querySelectorAll('.cm-content');
            for (const ct of Array.from(cmContents)) {
                const view = (_b = (_a = ct.cmView) === null || _a === void 0 ? void 0 : _a.view) !== null && _b !== void 0 ? _b : ct.cmView;
                if (!(view === null || view === void 0 ? void 0 : view.state)) {
                    continue;
                }
                const sel = view.state.selection.main;
                if (sel.empty) {
                    continue;
                }
                const text = view.state.sliceDoc(sel.from, sel.to);
                if (!text.trim()) {
                    continue;
                }
                const startLine = view.state.doc.lineAt(sel.from).number;
                const endLine = view.state.doc.lineAt(sel.to).number;
                const startCol = sel.from - view.state.doc.lineAt(sel.from).from + 1;
                const endCol = sel.to - view.state.doc.lineAt(sel.to).from;
                const editorRoot = ct.closest('.cm-editor');
                const cellNode = editorRoot === null || editorRoot === void 0 ? void 0 : editorRoot.closest('.jp-Cell');
                if (cellNode) {
                    const nb = this._currentNotebook();
                    if (nb) {
                        let cellIndex = -1;
                        nb.content.widgets.forEach((w, i) => {
                            if (cellIndex === -1 && w.node && w.node.contains(editorRoot)) {
                                cellIndex = i;
                            }
                        });
                        return {
                            source: 'notebook',
                            path: nb.context.path,
                            location: `cell ${cellIndex} · L${startLine}:${startCol}-${endLine}:${endCol}`,
                            text,
                            cellIndex,
                            startLine,
                            endLine,
                            startCol,
                            endCol
                        };
                    }
                }
                const path = this._findPathByNode(editorRoot);
                return {
                    source: 'file',
                    path,
                    location: `L${startLine}:${startCol}-${endLine}:${endCol}`,
                    text,
                    startLine,
                    endLine,
                    startCol,
                    endCol
                };
            }
        }
        catch (_c) {
            /* ignore */
        }
        return null;
    }
    /** 通过 DOM 节点归属找到主区 widget 的文件路径。 */
    _findPathByNode(node) {
        var _a;
        if (!node) {
            return '';
        }
        try {
            for (const w of Array.from(this._app.shell.widgets('main'))) {
                const we = w;
                if (we.node && we.node.contains(node) && typeof ((_a = we.context) === null || _a === void 0 ? void 0 : _a.path) === 'string') {
                    return we.context.path;
                }
            }
        }
        catch (_b) {
            /* ignore */
        }
        return '';
    }
    /**
     * notebook 选中的整 cell（代码块）：只要 cell 被选中（无论空/非空、命令/编辑模式）
     * 就取其全部内容作为选区。无任何选中 cell 时，若活动 cell 为空也视为选区（生成代码场景）。
     */
    _notebookSelectedCells(nb) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const model = nb.content.model;
        if (!model) {
            return null;
        }
        const content = nb.content;
        // 用 selectedCells 取选中的 cell（实测 isSelected(cell) 对点击选中的 cell 返回 False，
        // 但 selectedCells 数组正确包含它，故以 selectedCells 为准）
        const selectedIndexes = [];
        try {
            const selCells = content.selectedCells || [];
            for (const sc of selCells) {
                const idx = this._cellIndexOf(nb, sc);
                if (idx >= 0 && !selectedIndexes.includes(idx)) {
                    selectedIndexes.push(idx);
                }
            }
        }
        catch (_j) {
            /* ignore */
        }
        // 兜底：个别版本 selectedCells 不可用时退回 isSelected
        if (selectedIndexes.length === 0) {
            nb.content.widgets.forEach((cell, i) => {
                let sel = false;
                try {
                    sel = typeof content.isSelected === 'function' ? content.isSelected(cell) : !!cell.isSelected;
                }
                catch (_a) {
                    sel = !!cell.isSelected;
                }
                if (sel) {
                    selectedIndexes.push(i);
                }
            });
        }
        let useIndexes = selectedIndexes;
        if (useIndexes.length === 0) {
            // 无选中 cell：活动 cell 为空时视为选区（等待生成代码）
            const activeIdx = Number(content.activeCellIndex);
            const activeEmpty = activeIdx >= 0 &&
                activeIdx < model.cells.length &&
                String((_d = (_c = (_b = (_a = model.cells.get(activeIdx)) === null || _a === void 0 ? void 0 : _a.sharedModel) === null || _b === void 0 ? void 0 : _b.getSource) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : '').trim() === '';
            if (!activeEmpty) {
                return null;
            }
            useIndexes = [activeIdx];
        }
        const parts = [];
        for (const idx of useIndexes) {
            parts.push(String((_h = (_g = (_f = (_e = model.cells.get(idx)) === null || _e === void 0 ? void 0 : _e.sharedModel) === null || _f === void 0 ? void 0 : _f.getSource) === null || _g === void 0 ? void 0 : _g.call(_f)) !== null && _h !== void 0 ? _h : ''));
        }
        const loc = useIndexes.length === 1
            ? `cell ${useIndexes[0]}（整个代码块）`
            : `cell ${useIndexes[0]}-${useIndexes[useIndexes.length - 1]}（整个代码块）`;
        return {
            source: 'notebook',
            path: nb.context.path,
            location: loc,
            text: parts.join('\n\n'),
            cellIndex: useIndexes[0]
        };
    }
    async _poll() {
        if (this._polling) {
            return;
        }
        this._polling = true;
        try {
            const res = await apiGet('notebook/pending');
            for (const task of res.tasks || []) {
                // 逐个执行并回传（不阻塞轮询）
                void this._runTask(task);
            }
        }
        catch (_a) {
            /* 轮询失败静默，下一轮重试 */
        }
        finally {
            this._polling = false;
        }
    }
    async _runTask(task) {
        let result;
        try {
            const params = task.params || {};
            switch (task.action) {
                case 'nb_get_selection':
                    result = this._getSelection(params);
                    break;
                case 'nb_list_cells':
                    result = this._listCells(params);
                    break;
                case 'nb_edit_cell':
                    result = await this._editCell(params);
                    break;
                case 'nb_insert_cell':
                    result = await this._insertCell(params);
                    break;
                case 'nb_delete_cell':
                    result = await this._deleteCell(params);
                    break;
                case 'nb_execute_cell':
                    result = await this._executeCell(params);
                    break;
                case 'nb_file_read':
                    result = this._fileRead(params);
                    break;
                case 'nb_file_edit':
                    result = await this._fileEdit(params);
                    break;
                default:
                    result = fail(`未知操作: ${task.action}`);
            }
        }
        catch (err) {
            result = fail(`前端执行异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
            await apiPost('notebook/result', { task_id: task.task_id, result });
        }
        catch (_a) {
            /* 回传失败由后端超时兜底 */
        }
    }
    // ------------------------------------------------------------------
    //  定位
    // ------------------------------------------------------------------
    _currentNotebook() {
        const nb = this._tracker.currentWidget;
        if (nb && !nb.isDisposed) {
            return nb;
        }
        return null;
    }
    _findCell(nb, params) {
        const model = nb.content.model;
        if (!model) {
            return null;
        }
        const cells = model.cells;
        let index = null;
        if (params.cell_index !== undefined && params.cell_index !== null) {
            index = Number(params.cell_index);
            if (index < 0 || index >= cells.length) {
                return null;
            }
        }
        else if (params.cell_id) {
            for (let i = 0; i < cells.length; i++) {
                const cell = cells.get(i);
                if (cell.id === params.cell_id || cell.sharedModel.getId() === params.cell_id) {
                    index = i;
                    break;
                }
            }
            if (index === null) {
                return null;
            }
        }
        else {
            // 默认活动 cell
            const active = nb.content.activeCell;
            if (!active) {
                return null;
            }
            index = this._cellIndexOf(nb, active);
            if (index < 0) {
                return null;
            }
            return { cell: active, index };
        }
        nb.content.activeCellIndex = index;
        const widget = nb.content.activeCell;
        return { cell: widget, index };
    }
    _cellIndexOf(nb, cell) {
        var _a;
        // cell 可能是 cell widget 或 cell model，两者都兼容
        const widgets = nb.content.widgets;
        for (let i = 0; i < widgets.length; i++) {
            if (widgets[i] === cell) {
                return i;
            }
        }
        const cells = (_a = nb.content.model) === null || _a === void 0 ? void 0 : _a.cells;
        if (!cells) {
            return -1;
        }
        for (let i = 0; i < cells.length; i++) {
            if (cells.get(i) === cell || cells.get(i) === (cell === null || cell === void 0 ? void 0 : cell.model)) {
                return i;
            }
        }
        return -1;
    }
    // ------------------------------------------------------------------
    //  1. nb_get_selection
    // ------------------------------------------------------------------
    _getSelection(params) {
        var _a, _b;
        const nb = this._currentNotebook();
        if (!nb) {
            return fail('当前没有打开的 notebook（请先打开 .ipynb 文件）');
        }
        const model = nb.content.model;
        if (!model) {
            return fail('notebook 模型未就绪');
        }
        const data = {
            notebook_path: nb.context.path,
            kernel: ((_b = (_a = nb.context.sessionContext.session) === null || _a === void 0 ? void 0 : _a.kernel) === null || _b === void 0 ? void 0 : _b.name) || null,
            cells: []
        };
        // 选中 cells（命令模式多选 / 活动 cell）
        const selectedIndexes = [];
        try {
            nb.content.widgets.forEach((cell, i) => {
                if (cell.isSelected) {
                    selectedIndexes.push(i);
                }
            });
        }
        catch (_c) {
            /* ignore */
        }
        if (selectedIndexes.length === 0) {
            const active = nb.content.activeCell;
            if (active) {
                const idx = this._cellIndexOf(nb, active);
                if (idx >= 0) {
                    selectedIndexes.push(idx);
                }
            }
        }
        for (const idx of selectedIndexes) {
            const cellModel = model.cells.get(idx);
            const info = {
                index: idx,
                id: cellModel.sharedModel.getId(),
                type: cellModel.type,
                code: cellModel.sharedModel.getSource(),
                selected_text: null
            };
            // 若该 cell 是活动 cell，尝试提取编辑器选区
            const active = nb.content.activeCell;
            if (active && this._cellIndexOf(nb, active) === idx) {
                info.selected_text = this._getEditorSelection(active);
            }
            data.cells.push(info);
        }
        const output = JSON.stringify(data, null, 2);
        return ok(output, data);
    }
    _getEditorSelection(cell) {
        var _a;
        try {
            const editor = cell.editor;
            if (!editor) {
                return null;
            }
            const sel = editor.getSelection();
            if (!sel || !sel.start || !sel.end) {
                return null;
            }
            const text = cell.model.sharedModel.getSource();
            const lines = text.split('\n');
            const { start, end } = sel;
            if (start.line === end.line) {
                return ((_a = lines[start.line]) === null || _a === void 0 ? void 0 : _a.slice(start.column, end.column)) || null;
            }
            const parts = [];
            parts.push((lines[start.line] || '').slice(start.column));
            for (let l = start.line + 1; l < end.line; l++) {
                parts.push(lines[l] || '');
            }
            parts.push((lines[end.line] || '').slice(0, end.column));
            return parts.join('\n');
        }
        catch (_b) {
            return null;
        }
    }
    // ------------------------------------------------------------------
    //  2. nb_list_cells
    // ------------------------------------------------------------------
    _listCells(params) {
        const nb = this._currentNotebook();
        if (!nb) {
            return fail('当前没有打开的 notebook（请先打开 .ipynb 文件）');
        }
        const model = nb.content.model;
        if (!model) {
            return fail('notebook 模型未就绪');
        }
        const maxCode = Number(params.max_code_chars) || 500;
        const maxOut = Number(params.max_output_chars) || 300;
        const includeOutputs = params.include_outputs !== false;
        const cells = [];
        const cellModels = model.cells;
        for (let i = 0; i < cellModels.length; i++) {
            const cm = cellModels.get(i);
            let code = cm.sharedModel.getSource();
            let truncated = false;
            if (code.length > maxCode) {
                code = code.slice(0, maxCode) + `\n... [已截断，共 ${code.length} 字符]`;
                truncated = true;
            }
            const info = {
                index: i,
                id: cm.sharedModel.getId(),
                type: cm.type,
                code,
                truncated
            };
            if (includeOutputs && cm.type === 'code') {
                const widget = nb.content.widgets[i];
                if (widget) {
                    const outs = [];
                    for (const o of widget.outputArea.model.toJSON()) {
                        if (o.output_type === 'stream') {
                            outs.push(String(o.text || '').slice(0, maxOut));
                        }
                        else if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
                            const mime = o.data;
                            outs.push(String((mime === null || mime === void 0 ? void 0 : mime['text/plain']) || '').slice(0, maxOut));
                        }
                        else if (o.output_type === 'error') {
                            outs.push(`${o.ename}: ${o.evalue}`.slice(0, maxOut));
                        }
                    }
                    info.outputs = outs.filter(Boolean);
                }
            }
            cells.push(info);
        }
        const output = JSON.stringify({ notebook_path: nb.context.path, cell_count: cells.length, cells }, null, 2);
        return ok(output, { cells });
    }
    /**
     * 在光标（行/列，1-based）处插入新代码行。
     * 列=1/缺省 → 插到该行上方（新代码成为第 line 行）；列>1 → 插到该行下方。
     */
    _insertAtCursor(source, newCode, line, col) {
        const lines = source.split('\n');
        const L = isNaN(line) ? lines.length + 1 : line;
        const spliceIdx = Math.max(0, Math.min(col > 1 ? L : L - 1, lines.length));
        lines.splice(spliceIdx, 0, newCode);
        return lines.join('\n');
    }
    // ------------------------------------------------------------------
    //  3. nb_edit_cell
    // ------------------------------------------------------------------
    async _editCell(params) {
        const nb = this._currentNotebook();
        if (!nb) {
            return fail('当前没有打开的 notebook（请先打开 .ipynb 文件）');
        }
        const found = this._findCell(nb, params);
        if (!found) {
            return fail('找不到目标 cell（请检查 cell_index / cell_id）');
        }
        const { cell, index } = found;
        const newCode = params.new_code;
        if (typeof newCode !== 'string') {
            return fail('必须提供 new_code 参数');
        }
        const current = cell.model.sharedModel.getSource();
        // 在光标处插入新行（不替换现有内容）
        if (params.insert_at_line !== undefined && params.insert_at_line !== null) {
            const line = parseInt(String(params.insert_at_line), 10);
            const col = params.insert_at_col !== undefined ? parseInt(String(params.insert_at_col), 10) : 1;
            cell.model.sharedModel.setSource(this._insertAtCursor(current, newCode, line, col));
            return ok(`已在 cell ${index} 第 ${line} 行${col > 1 ? '下方' : '上方'}插入代码`);
        }
        // 替换选中片段
        if (params.selection_text !== undefined && params.selection_text !== null) {
            const target = String(params.selection_text);
            // 优先用编辑器当前选区的精确位置（避免 indexOf 命中重复文本的错误位置，
            // 如 "111111" 选中后两个 1 时不会误改前两个）
            const selRange = this._cellSelectionRange(cell);
            if (selRange && selRange.text === target) {
                cell.model.sharedModel.setSource(current.slice(0, selRange.start) + newCode + current.slice(selRange.end));
            }
            else {
                const pos = current.indexOf(target);
                if (pos === -1) {
                    return fail(`未在 cell ${index} 中找到与 selection_text 匹配的文本（前后文可能已变化）`);
                }
                cell.model.sharedModel.setSource(current.slice(0, pos) + newCode + current.slice(pos + target.length));
            }
        }
        else {
            // 整体替换
            cell.model.sharedModel.setSource(newCode);
        }
        let typeNote = '';
        if (params.cell_type && params.cell_type !== cell.model.type) {
            typeNote = this._setCellType(nb, index, params.cell_type)
                ? `，类型改为 ${params.cell_type}`
                : '，但类型修改失败';
        }
        return ok(`已修改 cell ${index}${params.selection_text !== undefined ? '（替换片段）' : '（整体替换）'}${typeNote}`);
    }
    /** 读取 cell 编辑器当前选区（文本 + 源码偏移量）。无选区返回 null。 */
    _cellSelectionRange(cell) {
        var _a;
        try {
            const editor = cell.editor;
            if (!editor || typeof editor.getSelection !== 'function') {
                return null;
            }
            const sel = editor.getSelection();
            if (!sel || !sel.start || !sel.end) {
                return null;
            }
            if (sel.start.line === sel.end.line && sel.start.column === sel.end.column) {
                return null;
            }
            const source = String((_a = cell.model.sharedModel.getSource()) !== null && _a !== void 0 ? _a : '');
            const lines = source.split('\n');
            const toOffset = (pos) => {
                let off = 0;
                for (let l = 0; l < pos.line; l++) {
                    off += (lines[l] || '').length + 1;
                }
                return off + pos.column;
            };
            const start = toOffset(sel.start);
            const end = toOffset(sel.end);
            return { text: source.slice(start, end), start, end };
        }
        catch (_b) {
            return null;
        }
    }
    /** 修改指定 cell 的类型（code/markdown/raw）。
     *
     * 走共享模型 `deleteCell + insertCell`（对齐 JupyterLab `Private.changeCellType`
     * 的内部实现），按 index 精确定位、不依赖选区，不会打断用户当前选中/活动状态。
     * ⚠️ JupyterLab 4 的 `ICellSharedModel` 上没有 `setCellType` 方法，直接调
     * `sharedModel.setCellType?.()` 是静默 no-op（旧实现的 bug）。
     * @returns 是否成功（已是目标类型时返回 true）。
     */
    _setCellType(nb, index, cellType) {
        try {
            const model = nb.content.model;
            if (!model) {
                return false;
            }
            const cellModel = model.cells.get(index);
            if (!cellModel) {
                return false;
            }
            if (cellModel.type === cellType) {
                return true; // 已是目标类型
            }
            const sharedModel = model.sharedModel; // YNotebookModel
            const raw = cellModel.toJSON();
            if (cellType === 'code') {
                raw.metadata.trusted = true; // 转 code 后清输出，可重新信任
            }
            else {
                raw.metadata.trusted = undefined; // trusted 仅对 code cell 有效
            }
            sharedModel.transact(() => {
                sharedModel.deleteCell(index);
                const newCell = sharedModel.insertCell(index, {
                    id: raw.id,
                    cell_type: cellType,
                    source: raw.source,
                    metadata: raw.metadata
                });
                if (raw.attachments && (cellType === 'markdown' || cellType === 'raw')) {
                    newCell.attachments = raw.attachments;
                }
            });
            // markdown 默认不渲染（与 JupyterLab 行为一致）
            if (cellType === 'markdown') {
                const w = nb.content.widgets[index];
                if (w) {
                    w.rendered = false;
                }
            }
            return true;
        }
        catch (_a) {
            return false;
        }
    }
    // ------------------------------------------------------------------
    //  4. nb_insert_cell
    // ------------------------------------------------------------------
    async _insertCell(params) {
        var _a;
        const nb = this._currentNotebook();
        if (!nb) {
            return fail('当前没有打开的 notebook（请先打开 .ipynb 文件）');
        }
        const model = nb.content.model;
        if (!model) {
            return fail('notebook 模型未就绪');
        }
        const code = String(params.code || '');
        const cellType = params.cell_type === 'markdown' ? 'markdown' : 'code';
        let index = params.cell_index !== undefined ? Number(params.cell_index) : null;
        if (index === null || index < 0 || index > model.cells.length) {
            index = nb.content.activeCellIndex + 1;
        }
        // 用官方 NotebookActions 插入（与用户手动操作一致，UI 实时同步）
        nb.content.activeCellIndex = Math.max(0, Math.min(index - 1, model.cells.length - 1));
        NotebookActions.insertBelow(nb.content);
        const newCell = nb.content.activeCell;
        if (!newCell) {
            return fail('插入 cell 失败');
        }
        newCell.model.sharedModel.setSource(code);
        if (cellType === 'markdown') {
            this._setCellType(nb, index, 'markdown');
        }
        if (params.execute && cellType === 'code') {
            const codeCell = nb.content.activeCell;
            if (codeCell instanceof CodeCell) {
                void this._executeCellInPlace(nb, codeCell, String((_a = codeCell.model.sharedModel.getSource()) !== null && _a !== void 0 ? _a : ''), 300000);
            }
        }
        return ok(`已在位置 ${index} 插入 ${cellType} cell`);
    }
    // ------------------------------------------------------------------
    //  5. nb_delete_cell
    // ------------------------------------------------------------------
    async _deleteCell(params) {
        const nb = this._currentNotebook();
        if (!nb) {
            return fail('当前没有打开的 notebook（请先打开 .ipynb 文件）');
        }
        const model = nb.content.model;
        if (!model) {
            return fail('notebook 模型未就绪');
        }
        let index = null;
        if (params.cell_index !== undefined && params.cell_index !== null) {
            index = Number(params.cell_index);
        }
        else if (params.cell_id) {
            for (let i = 0; i < model.cells.length; i++) {
                if (model.cells.get(i).sharedModel.getId() === params.cell_id) {
                    index = i;
                    break;
                }
            }
        }
        else {
            index = nb.content.activeCellIndex;
        }
        if (index === null || index < 0 || index >= model.cells.length) {
            return fail('找不到目标 cell');
        }
        nb.content.activeCellIndex = index;
        NotebookActions.deleteCells(nb.content);
        return ok(`已删除 cell ${index}`);
    }
    // ------------------------------------------------------------------
    //  6. nb_execute_cell
    // ------------------------------------------------------------------
    async _executeCell(params) {
        const nb = this._currentNotebook();
        if (!nb) {
            return fail('当前没有打开的 notebook（请先打开 .ipynb 文件）');
        }
        const timeoutMs = (Number(params.timeout) || 300) * 1000;
        // 方式一：直接执行 code（不写入 notebook）
        if (params.code !== undefined && params.cell_index === undefined && params.cell_id === undefined) {
            return this._executeCode(nb, String(params.code), timeoutMs, false);
        }
        // 方式二：定位 cell（可先写入 code 再执行）
        const found = this._findCell(nb, params);
        if (!found) {
            return fail('找不到目标 cell（请检查 cell_index / cell_id）');
        }
        const { cell, index } = found;
        if (!(cell instanceof CodeCell)) {
            return fail(`cell ${index} 不是代码 cell，无法执行`);
        }
        if (params.code !== undefined) {
            cell.model.sharedModel.setSource(String(params.code));
        }
        const code = cell.model.sharedModel.getSource();
        if (!code.trim()) {
            return fail('目标 cell 为空，无可执行代码');
        }
        // 在 cell 内执行并渲染输出（与 Shift+Enter 一致）
        return this._executeCellInPlace(nb, cell, String(code), timeoutMs);
    }
    /** 在指定 cell 内执行代码：输出实时渲染到 cell 的输出区，完成后提取输出回传。 */
    async _executeCellInPlace(nb, cell, code, timeoutMs) {
        var _a, _b;
        const sessionContext = nb.context.sessionContext;
        const kernel = (_a = sessionContext.session) === null || _a === void 0 ? void 0 : _a.kernel;
        if (!kernel) {
            return fail('notebook 内核未连接（请先启动内核）');
        }
        try {
            cell.outputArea.model.clear();
        }
        catch (_c) {
            /* ignore */
        }
        let timer = 0;
        const timeoutPromise = new Promise((_, rej) => {
            timer = window.setTimeout(() => {
                try {
                    void kernel.interrupt();
                }
                catch (_a) {
                    /* ignore */
                }
                rej(new Error(`执行超时（${timeoutMs / 1000}s），已中断`));
            }, timeoutMs);
        });
        let reply;
        try {
            reply = await Promise.race([
                OutputArea.execute(code, cell.outputArea, sessionContext),
                timeoutPromise
            ]);
        }
        catch (err) {
            window.clearTimeout(timer);
            return fail((err === null || err === void 0 ? void 0 : err.message) || String(err));
        }
        window.clearTimeout(timer);
        const { outputs, errorText, resultText } = this._extractCellOutputs(cell);
        const ec = (_b = reply === null || reply === void 0 ? void 0 : reply.content) === null || _b === void 0 ? void 0 : _b.execution_count;
        if (ec !== undefined && ec !== null) {
            try {
                cell.model.executionCount = ec;
            }
            catch (_d) {
                /* ignore */
            }
        }
        if (errorText) {
            return {
                success: false,
                output: outputs.join('\n'),
                error: errorText,
                data: { result: resultText }
            };
        }
        return {
            success: true,
            output: outputs.join('\n') || '（执行完成，无输出）',
            error: '',
            data: { result: resultText }
        };
    }
    /** 从 cell 输出区提取文本输出（供回传 Agent）。 */
    _extractCellOutputs(cell) {
        const outputs = [];
        let errorText = '';
        let resultText = '';
        try {
            for (const o of cell.outputArea.model.toJSON()) {
                const oo = o;
                const ot = oo.output_type;
                if (ot === 'stream') {
                    outputs.push(String(oo.text || '').replace(/\n$/, ''));
                }
                else if (ot === 'execute_result' || ot === 'display_data') {
                    const txt = String((oo.data || {})['text/plain'] || '');
                    if (ot === 'execute_result') {
                        resultText = txt;
                    }
                    if (txt) {
                        outputs.push(txt.replace(/\n$/, ''));
                    }
                }
                else if (ot === 'error') {
                    errorText = (oo.traceback || []).join('\n') || `${oo.ename}: ${oo.evalue}`;
                    outputs.push(`[error] ${oo.ename}: ${oo.evalue}`);
                }
            }
        }
        catch (_a) {
            /* ignore */
        }
        return { outputs, errorText, resultText };
    }
    _executeCode(nb, code, timeoutMs, syncCell = false) {
        return new Promise(resolve => {
            var _a;
            const kernel = (_a = nb.context.sessionContext.session) === null || _a === void 0 ? void 0 : _a.kernel;
            if (!kernel) {
                resolve(fail('notebook 内核未连接（请先启动内核）'));
                return;
            }
            const future = kernel.requestExecute({ code });
            const outputs = [];
            let errorText = '';
            let stdout = '';
            let stderr = '';
            let resultText = '';
            future.onIOPub = msg => {
                const type = msg.header.msg_type;
                const content = msg.content || {};
                try {
                    if (type === 'stream') {
                        const text = String(content.text || '');
                        if (content.name === 'stdout') {
                            stdout += text;
                            outputs.push(text.replace(/\n$/, ''));
                        }
                        else {
                            stderr += text;
                            outputs.push(`[stderr] ${text}`.replace(/\n$/, ''));
                        }
                    }
                    else if (type === 'execute_result' || type === 'display_data') {
                        const d = content.data || {};
                        const txt = d['text/plain'] !== undefined ? String(d['text/plain']) : '';
                        if (type === 'execute_result') {
                            resultText = txt;
                        }
                        if (txt) {
                            outputs.push(txt.replace(/\n$/, ''));
                        }
                    }
                    else if (type === 'error') {
                        const tb = content.traceback || [];
                        errorText = tb.join('\n') || `${content.ename}: ${content.evalue}`;
                        outputs.push(`[error] ${content.ename}: ${content.evalue}`);
                    }
                }
                catch (_a) {
                    /* 单条输出解析失败忽略 */
                }
            };
            const timer = window.setTimeout(() => {
                try {
                    void kernel.interrupt();
                }
                catch (_a) {
                    /* ignore */
                }
                resolve(fail(`执行超时（${timeoutMs / 1000}s）`));
            }, timeoutMs);
            future.done
                .then(() => {
                window.clearTimeout(timer);
                if (errorText) {
                    resolve({
                        success: false,
                        output: outputs.join('\n'),
                        error: errorText,
                        data: { stdout, stderr, result: resultText }
                    });
                }
                else {
                    resolve({
                        success: true,
                        output: outputs.join('\n') || '（执行完成，无输出）',
                        error: '',
                        data: { stdout, stderr, result: resultText }
                    });
                }
            })
                .catch((err) => {
                window.clearTimeout(timer);
                resolve(fail(`内核执行失败: ${(err === null || err === void 0 ? void 0 : err.message) || String(err)}`));
            });
        });
    }
    // ------------------------------------------------------------------
    //  7. nb_file_read
    // ------------------------------------------------------------------
    _fileRead(params) {
        const editor = this._findFileEditor(params.path, params.filename);
        if (!editor) {
            return fail(`未找到打开的文件${params.filename ? ` '${params.filename}'` : ` '${params.path}'`}。` +
                '请先在 JupyterLab 中打开该文件。');
        }
        const text = this._fileEditorSource(editor);
        const lines = text.split('\n');
        const start = params.start_line ? Number(params.start_line) : 1;
        const end = params.end_line ? Number(params.end_line) : lines.length;
        const slice = lines.slice(Math.max(1, start) - 1, Math.max(1, end));
        let content = slice.join('\n');
        const maxChars = Number(params.max_chars) || 5000;
        let truncated = false;
        if (content.length > maxChars) {
            content = content.slice(0, maxChars) + `\n... [已截断，共 ${lines.length} 行]`;
            truncated = true;
        }
        const data = {
            path: editor.context.path,
            line_count: lines.length,
            start_line: Math.max(1, start),
            end_line: Math.min(lines.length, Math.max(1, end)),
            truncated,
            content
        };
        return ok(JSON.stringify(data, null, 2), data);
    }
    // ------------------------------------------------------------------
    //  8. nb_file_edit
    // ------------------------------------------------------------------
    async _fileEdit(params) {
        var _a, _b, _c, _d, _e;
        const editor = this._findFileEditor(params.path, params.filename);
        if (!editor) {
            return fail(`未找到打开的文件${params.filename ? ` '${params.filename}'` : ` '${params.path}'`}。` +
                '请先在 JupyterLab 中打开该文件。');
        }
        const cmEditor = this._cmEditorOf(editor);
        const sharedModel = (_a = cmEditor === null || cmEditor === void 0 ? void 0 : cmEditor.model) === null || _a === void 0 ? void 0 : _a.sharedModel;
        if (!sharedModel || typeof sharedModel.setSource !== 'function') {
            return fail('无法访问文件编辑器内容');
        }
        const source = String((_b = sharedModel.getSource()) !== null && _b !== void 0 ? _b : '');
        let newText = null;
        let desc = '';
        // 在光标处插入新行（不替换现有内容）
        if (params.insert_at_line !== undefined && params.insert_at_line !== null) {
            const insertStr = String((_c = params.new_str) !== null && _c !== void 0 ? _c : '');
            const line = parseInt(String(params.insert_at_line), 10);
            const col = params.insert_at_col !== undefined ? parseInt(String(params.insert_at_col), 10) : 1;
            sharedModel.setSource(this._insertAtCursor(source, insertStr, line, col));
            return ok(`已在文件 ${editor.context.path} 第 ${line} 行${col > 1 ? '下方' : '上方'}插入内容，` +
                '记得在编辑器中保存（Ctrl+S）');
        }
        if (params.content !== undefined) {
            newText = String(params.content);
            desc = '整体替换';
        }
        else if (params.old_str !== undefined) {
            const oldStr = String(params.old_str);
            const newStr = String((_d = params.new_str) !== null && _d !== void 0 ? _d : '');
            const pos = source.indexOf(oldStr);
            if (pos === -1) {
                return fail('old_str 与文件内容不匹配（可能已被修改，请先 nb_file_read 查看最新内容）');
            }
            newText = source.slice(0, pos) + newStr + source.slice(pos + oldStr.length);
            desc = '字符串替换';
        }
        else if (params.selection_text !== undefined) {
            // 用编辑器当前选区的精确位置替换（避免 indexOf 命中重复文本的错误位置）
            const target = String(params.selection_text);
            const selInfo = this._extractSelFromCm(cmEditor);
            if (!selInfo) {
                return fail('文件中当前没有选中文本');
            }
            if (selInfo.text !== target) {
                return fail('selection_text 与当前选中内容不一致（请用 nb_file_read 查看最新内容）');
            }
            const lines = source.split('\n');
            let pos = 0;
            for (let l = 0; l < selInfo.startLine - 1; l++) {
                pos += (lines[l] || '').length + 1;
            }
            pos += selInfo.startCol - 1;
            const newText2 = source.slice(0, pos) + String((_e = params.new_str) !== null && _e !== void 0 ? _e : '') + source.slice(pos + target.length);
            sharedModel.setSource(newText2);
            return ok(`已替换文件选中内容（${editor.context.path}），记得在编辑器中保存（Ctrl+S）`);
        }
        else {
            return fail('必须提供 content / old_str / selection_text 之一');
        }
        if (newText !== null) {
            sharedModel.setSource(newText);
        }
        return ok(`已修改文件 ${editor.context.path}（${desc}），记得在编辑器中保存（Ctrl+S）`);
    }
    // ------------------------------------------------------------------
    //  文件编辑器定位
    // ------------------------------------------------------------------
    /**
     * 按 path / filename 查找已打开的文件编辑器。
     *
     * JupyterLab4 中主区文件 widget 是 `FileEditorWidget extends DocumentWidget<FileEditor>`：
     * 路径在 `widget.context.path`，CodeMirrorEditor 在 `widget.content.editor`
     * （旧代码误用 `widget.editor` 导致非 ipynb 文件一律找不到）。
     */
    _findFileEditor(path, filename) {
        let found = null;
        let foundScore = -1;
        const widgets = Array.from(this._app.shell.widgets('main'));
        const norm = (s) => String(s || '').replace(/\/+$/, '');
        for (const w of widgets) {
            const we = w;
            if (!this._isFileEditorWidget(we)) {
                continue;
            }
            const p = String(we.context.path);
            const base = p.split('/').pop() || p;
            let score = -1;
            if (path) {
                const np = norm(path);
                const wp = norm(p);
                if (wp === np) {
                    score = 3; // 完全一致
                }
                else if (np.endsWith('/' + wp) || np === wp) {
                    score = 3; // 绝对路径以 widget 相对路径结尾（/tmp/a.txt vs a.txt）
                }
                else if (wp.endsWith('/' + np) || p.endsWith('/' + np)) {
                    score = 2; // widget 相对路径以给定路径结尾
                }
                else if (base === (np.split('/').pop() || np)) {
                    score = 1; // 仅文件名相同
                }
            }
            if (score < 0 && filename && base === filename) {
                score = 1; // 文件名匹配
            }
            if (score > foundScore) {
                foundScore = score;
                found = we;
            }
        }
        return foundScore > 0 ? found : null;
    }
    /** 从文件编辑器 widget 取共享模型源码。 */
    _fileEditorSource(w) {
        var _a, _b, _c, _d;
        const ed = this._cmEditorOf(w);
        try {
            return String((_d = (_c = (_b = (_a = ed === null || ed === void 0 ? void 0 : ed.model) === null || _a === void 0 ? void 0 : _a.sharedModel) === null || _b === void 0 ? void 0 : _b.getSource) === null || _c === void 0 ? void 0 : _c.call(_b)) !== null && _d !== void 0 ? _d : '');
        }
        catch (_e) {
            return '';
        }
    }
}

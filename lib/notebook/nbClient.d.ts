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
import { INotebookTracker } from '@jupyterlab/notebook';
import { JupyterFrontEnd } from '@jupyterlab/application';
/** 实时选区上下文（需求8：鼠标选中的代码块/代码/文件）。 */
export interface SelectionContext {
    source: 'notebook' | 'file';
    /** 文件/notebook 路径 */
    path: string;
    /** 人类可读位置，如 "cell 3 · L5:2-12:8" 或 "L10:1-25:6" */
    location: string;
    /** 选中的文本内容 */
    text: string;
    cellIndex?: number;
    startLine?: number;
    endLine?: number;
    /** 列号（1 起；endCol 为 1-based 结束列） */
    startCol?: number;
    endCol?: number;
    /** true = 光标位置（无文本选中），用户想在此插入代码；text 为光标所在行内容 */
    isCursor?: boolean;
}
export declare class NotebookClient {
    private _app;
    private _tracker;
    private _timer;
    private _polling;
    constructor(_app: JupyterFrontEnd, _tracker: INotebookTracker);
    /** 启动 UI 任务轮询（200ms 间隔）。 */
    start(): void;
    /** 停止轮询。 */
    stop(): void;
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
    getCurrentSelectionContext(): SelectionContext | null;
    /** widget 是否为文件编辑器（FileEditorWidget：content.editor 是 CodeMirrorEditor）。 */
    private _isFileEditorWidget;
    /** 从 widget 取 CodeMirrorEditor（兼容 FileEditorWidget / FileEditor）。 */
    private _cmEditorOf;
    /** 由 CodeMirror 选区（0-based line/column）抽取文本 + 行列号（1-based）。 */
    private _extractSelFromCm;
    /**
     * 提取光标位置（空选区，即 start==end）。返回 1-based line/col + 光标所在行内容。
     * 有实际选中范围时返回 null（交给选区逻辑处理）。
     */
    private _extractCursorFromCm;
    /** notebook 是否处于编辑态（用户光标在 cell 代码中）。命令态下不识别光标，避免误报。 */
    private _isNbEditMode;
    /** notebook 某 cell 的光标位置上下文（空选区，用户想在此插入代码）。 */
    private _cellCursorCtx;
    /** 文件编辑器的光标位置上下文（空选区）。 */
    private _fileEditorCursorCtx;
    /** notebook 某 cell 的文本选区上下文（含列号）。 */
    private _cellTextSelectionCtx;
    /** 文件编辑器的文本选区上下文（含列号）。 */
    private _fileEditorSelectionCtx;
    /** 遍历主区文件编辑器，返回第一个有文本选区的。 */
    private _anyFileEditorSelection;
    /** 兜底：遍历页面所有 CodeMirror 编辑器，返回第一个有选区的（含列号）。 */
    private _anyEditorTextSelection;
    /** 通过 DOM 节点归属找到主区 widget 的文件路径。 */
    private _findPathByNode;
    /**
     * notebook 选中的整 cell（代码块）：只要 cell 被选中（无论空/非空、命令/编辑模式）
     * 就取其全部内容作为选区。无任何选中 cell 时，若活动 cell 为空也视为选区（生成代码场景）。
     */
    private _notebookSelectedCells;
    private _poll;
    private _runTask;
    private _currentNotebook;
    private _findCell;
    private _cellIndexOf;
    private _getSelection;
    private _getEditorSelection;
    private _listCells;
    /**
     * 在光标（行/列，1-based）处插入新代码行。
     * 列=1/缺省 → 插到该行上方（新代码成为第 line 行）；列>1 → 插到该行下方。
     */
    private _insertAtCursor;
    private _editCell;
    /** 读取 cell 编辑器当前选区（文本 + 源码偏移量）。无选区返回 null。 */
    private _cellSelectionRange;
    private _insertCell;
    private _deleteCell;
    private _executeCell;
    /** 在指定 cell 内执行代码：输出实时渲染到 cell 的输出区，完成后提取输出回传。 */
    private _executeCellInPlace;
    /** 从 cell 输出区提取文本输出（供回传 Agent）。 */
    private _extractCellOutputs;
    private _executeCode;
    private _fileRead;
    private _fileEdit;
    /**
     * 按 path / filename 查找已打开的文件编辑器。
     *
     * JupyterLab4 中主区文件 widget 是 `FileEditorWidget extends DocumentWidget<FileEditor>`：
     * 路径在 `widget.context.path`，CodeMirrorEditor 在 `widget.content.editor`
     * （旧代码误用 `widget.editor` 导致非 ipynb 文件一律找不到）。
     */
    private _findFileEditor;
    /** 从文件编辑器 widget 取共享模型源码。 */
    private _fileEditorSource;
}

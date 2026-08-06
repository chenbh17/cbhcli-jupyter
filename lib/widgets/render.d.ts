/**
 * 渲染模块：对齐 cbhcli Web 界面（markdown / 语法高亮 / 代码复制 / 工具 diff / ANSI 清理）。
 * 移植自 cbhcli_pkg/web/static/js/app.js。
 */
import 'katex/dist/katex.min.css';
export declare function escapeHtml(s: string): string;
/** 去除 ANSI 转义序列（终端/工具输出可能携带颜色码，如 \x1b[36m）。 */
export declare function stripAnsi(s: any): string;
/** 复制文本到剪贴板（兼容非安全上下文）。 */
export declare function copyText(text: string): Promise<void>;
export declare function renderMarkdown(text: string): string;
export declare function renderDiagrams(container: HTMLElement): Promise<void>;
export declare function guessLang(filePath: string): string | null;
export declare function highlightCode(code: string, lang: string | null): string;
/** 代码块元素（带语法高亮 + 复制按钮 + 可选标签）。 */
export declare function codeBlockEl(code: string, lang: string | null, labelText?: string): HTMLElement;
/** 为已渲染的 markdown 容器中的代码块补上高亮 + 复制按钮。 */
export declare function enhanceCodeBlocks(container: HTMLElement): void;
export declare function diffBlockEl(oldStr: string, newStr: string, lang: string | null, labelText?: string): HTMLElement;
/** Todo 参数防御性解析（模型可能传 JSON 字符串/嵌套对象/非数组）。 */
export declare function normalizeTodos(args: any): {
    content: string;
    status: string;
}[];
/** Todo 任务面板元素（📋 标题 + done/total + 每项 ✓/◐/○ 标记）。 */
export declare function todoPanelEl(todos: {
    content: string;
    status: string;
}[]): HTMLElement;
export declare function renderToolArgs(container: HTMLElement, name: string, args: any): void;
/** 渲染工具结果输出（去 ANSI；python/terminal 输出用等宽块）。 */
export declare function renderToolResult(container: HTMLElement, name: string, preview: string, okFlag: boolean): void;

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
import { JupyterFrontEnd } from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
export declare class CbhcliPanel extends Widget {
    private _nbClient;
    private _settings;
    private _fbFactory;
    private _agentSelect;
    private _modelSelect;
    private _pathEl;
    private _ctxFill;
    private _ctxPct;
    private _ctxFraction;
    private _eyeWrap;
    private _eyeBtn;
    private _eyeInfo;
    private _selectionCtx;
    private _selectionEnabled;
    private _selPollTimer;
    private _lastSelKey;
    private _messagesEl;
    private _inputEl;
    private _sendBtn;
    private _stopBtn;
    private _backendErrorEl;
    private _serverRoot;
    private _currentRelPath;
    private _pathSlot;
    private _boundBrowserModel;
    private _agentName;
    private _agentInited;
    private _modelName;
    private _busy;
    private _abortFn;
    constructor(app: JupyterFrontEnd, notebookTracker: INotebookTracker, fileBrowserFactory: IFileBrowserFactory | null);
    dispose(): void;
    private _build;
    private _setupPathTracking;
    private _unbindBrowserPath;
    private _bindBrowserPath;
    private _refreshPath;
    private _joinPath;
    private _updateCtxMeter;
    private _startSelectionPoll;
    private _refreshSelection;
    private _toggleSelection;
    /** 构造附带选区上下文的完整消息。返回 {display, payload}。 */
    private _buildSelectionContext;
    private _initChoices;
    /** v0.3.3：显示后端加载失败横幅（含安装指引）。 */
    private _showBackendError;
    /** v0.3.3：隐藏后端错误横幅。 */
    private _hideBackendError;
    /** v5.4.0（认证系统）：显示未登录提示横幅（引导 cbhcli login / web 登录界面）。 */
    private _showNotLoggedIn;
    private _onAgentChange;
    private _onModelChange;
    private _refreshStatus;
    private _compress;
    private _newChat;
    private _showModal;
    private _openToolsModal;
    private _openSkillsModal;
    /** 轻量 MCP 弹窗：列出各 MCP 服务器的工具并勾选启用/禁用。 */
    private _openMcpModal;
    /** 轻量链条弹窗：单选激活/取消当前会话的链条（仿 web showChainPicker）。 */
    private _openChainModal;
    private _addUserMessage;
    private _addSystemNote;
    private _scrollBottom;
    private _send;
    private _stop;
    private _setBusy;
    private _runChat;
}

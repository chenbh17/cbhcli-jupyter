/**
 * 配置面板（v0.2 重构，仿 cbhcli Web 管理界面）。
 *
 * 分区：模型管理 / 备用模型（可增删排序）/ 权限模式 / 历史会话。
 * Agent 与当前模型的选择只在主面板顶栏，这里不再重复显示。
 */
import { Widget } from '@lumino/widgets';
interface SettingsCtx {
    getAgent: () => string;
    getModel: () => string;
    notify: () => void;
}
export declare class SettingsPanel extends Widget {
    private _ctx;
    private _root;
    /** 历史会话折叠状态（true=收起只显示标题行）。跨 refresh 保留。 */
    private _historyCollapsed;
    constructor(_ctx: SettingsCtx);
    refresh(): Promise<void>;
    private _buildModelsSection;
    private _buildFallbackSection;
    private _fallbackCategory;
    private _addFallback;
    private _removeFallback;
    private _clearFallback;
    private _reorderFallback;
    private _buildPermissionsSection;
    private _setPermissionMode;
    private _buildHistorySection;
    /** 单个历史会话条目：标题（首条用户消息）+ 元信息 + 恢复/删除。 */
    private _historyItem;
    /** ISO 时间 → "MM-DD HH:mm"。 */
    private _fmtHistoryDate;
    private _loadHistory;
    private _deleteHistory;
    private _selectModel;
    private _addModel;
    private _editModel;
    private _deleteModel;
    private _modelForm;
    private _collectForm;
    private _buildMcpSection;
    private _addMcpServerDialog;
    private _buildChainSection;
    private _section;
    private _showDialog;
}
export {};

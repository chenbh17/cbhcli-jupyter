/**
 * cbhcli-jupyter 插件入口。
 *
 * 注册左侧栏图标 + 主面板（问答 / 配置 Tab）。
 * ⚠️ 快捷键安全：本插件不注册任何全局键盘快捷键（无 KeyBinding / addKeydownHandler），
 * 输入框使用原生 textarea，中断通过按钮实现——不影响 JupyterLab 终端/notebook 的任何快捷键。
 */
import { ILabShell } from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { LabIcon } from '@jupyterlab/ui-components';
import { CbhcliPanel } from './widgets/chatPanel';
// ---------------------------------------------------------------------------
//  品牌图标（SVG，内联）
// ---------------------------------------------------------------------------
// 与 cbhcli Web 界面浏览器图标（favicon.svg）一致：深色圆角底 + 蓝色箭头。
// ⚠️ 无自定义 id（JupyterLab 内联渲染所有图标，重复 id 会污染全局）。
export const cbhcliIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="16" height="16">
  <rect width="48" height="48" rx="11" fill="#11151d"/>
  <rect x="0.5" y="0.5" width="47" height="47" rx="10.5" fill="none" stroke="#2a3240"/>
  <path d="M16 11 L34 24 L16 37" fill="none" stroke="#4f8cff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
export const cbhcliIcon = new LabIcon({
    name: 'cbhcli-jupyter:icon',
    svgstr: cbhcliIconSvg
});
// ---------------------------------------------------------------------------
//  插件
// ---------------------------------------------------------------------------
const plugin = {
    id: 'cbhcli-jupyter:plugin',
    description: '基于 cbhcli 的 JupyterLab AI 助手：侧边栏问答 + notebook 代码操作',
    autoStart: true,
    requires: [ILabShell, INotebookTracker],
    optional: [IFileBrowserFactory],
    activate: (app, labShell, notebookTracker, fileBrowserFactory) => {
        let panel = null;
        const getPanel = () => {
            if (!panel || panel.isDisposed) {
                panel = new CbhcliPanel(app, notebookTracker, fileBrowserFactory);
                panel.id = 'cbhcli-jupyter-panel';
                panel.title.label = 'cbhcli';
                panel.title.icon = cbhcliIcon;
                panel.title.caption = 'cbhcli AI 助手（问答 + notebook 操作）';
            }
            return panel;
        };
        // 打开命令（不绑定任何快捷键）
        app.commands.addCommand('cbhcli-jupyter:open', {
            label: '打开 cbhcli AI 助手',
            caption: '打开 cbhcli 侧边栏问答面板',
            icon: cbhcliIcon,
            execute: () => {
                const p = getPanel();
                if (!p.isAttached) {
                    labShell.add(p, 'left', { rank: 900 });
                }
                labShell.activateById(p.id);
            }
        });
        // 关闭命令
        app.commands.addCommand('cbhcli-jupyter:close', {
            label: '关闭 cbhcli AI 助手',
            caption: '关闭 cbhcli 侧边栏问答面板',
            icon: cbhcliIcon,
            execute: () => {
                if (panel && panel.isAttached && !panel.isDisposed) {
                    panel.close();
                }
            }
        });
        // 侧边栏图标（点击展开/收起面板；不主动抢焦点，避免干扰 JupyterLab 启动布局）
        const p = getPanel();
        labShell.add(p, 'left', { rank: 900 });
        console.log('[cbhcli-jupyter] 插件已激活');
    }
};
export default plugin;

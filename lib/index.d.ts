/**
 * cbhcli-jupyter 插件入口。
 *
 * 注册左侧栏图标 + 主面板（问答 / 配置 Tab）。
 * ⚠️ 快捷键安全：本插件不注册任何全局键盘快捷键（无 KeyBinding / addKeydownHandler），
 * 输入框使用原生 textarea，中断通过按钮实现——不影响 JupyterLab 终端/notebook 的任何快捷键。
 */
import { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { LabIcon } from '@jupyterlab/ui-components';
export declare const cbhcliIconSvg = "\n<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 48 48\" width=\"16\" height=\"16\">\n  <rect width=\"48\" height=\"48\" rx=\"11\" fill=\"#11151d\"/>\n  <rect x=\"0.5\" y=\"0.5\" width=\"47\" height=\"47\" rx=\"10.5\" fill=\"none\" stroke=\"#2a3240\"/>\n  <path d=\"M16 11 L34 24 L16 37\" fill=\"none\" stroke=\"#4f8cff\" stroke-width=\"5.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n</svg>";
export declare const cbhcliIcon: LabIcon;
declare const plugin: JupyterFrontEndPlugin<void>;
export default plugin;

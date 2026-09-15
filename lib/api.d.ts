/**
 * API 客户端：与 cbhcli_jupyter 后端（tornado handlers）通信。
 *
 * 使用 JupyterLab 的 ServerConnection（自动处理 XSRF/认证），
 * 避免裸 fetch 的 403 问题。
 */
/** 构造 API URL（前缀 /cbhcli/api）。 */
export declare function apiUrl(path: string): string;
/** 发起 JSON 请求并解析响应（自动带 XSRF 认证）。 */
export declare function requestAPI<T = any>(path: string, init?: RequestInit): Promise<T>;
/** GET 请求。 */
export declare function apiGet<T = any>(path: string): Promise<T>;
/** POST 请求（JSON body）。 */
export declare function apiPost<T = any>(path: string, body?: any): Promise<T>;
/** PUT 请求（JSON body）。 */
export declare function apiPut<T = any>(path: string, body?: any): Promise<T>;
/** DELETE 请求。 */
export declare function apiDelete<T = any>(path: string, body?: any): Promise<T>;
/**
 * SSE 聊天流（自动带 XSRF 认证）。
 * 逐事件回调；返回取消函数。
 */
export declare function streamChat(payload: {
    agent_name: string;
    model_name: string;
    message: string;
    images?: string[];
    cwd?: string;
    /** 小眼睛严格模式：仅当注入了选区上下文时为 true，后端据此启用/禁用 nb 工具 */
    nb_enabled?: boolean;
}, onEvent: (ev: any) => void, onError: (err: Error & {
    notLoggedIn?: boolean;
}) => void, onDone: () => void, signal?: AbortSignal): () => void;

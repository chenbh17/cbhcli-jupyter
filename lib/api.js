/**
 * API 客户端：与 cbhcli_jupyter 后端（tornado handlers）通信。
 *
 * 使用 JupyterLab 的 ServerConnection（自动处理 XSRF/认证），
 * 避免裸 fetch 的 403 问题。
 */
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
const SETTINGS = ServerConnection.makeSettings();
/** 构造 API URL（前缀 /cbhcli/api）。 */
export function apiUrl(path) {
    return URLExt.join(SETTINGS.baseUrl, 'cbhcli/api', path);
}
/** 发起 JSON 请求并解析响应（自动带 XSRF 认证）。 */
export async function requestAPI(path, init) {
    const response = await ServerConnection.makeRequest(apiUrl(path), init !== null && init !== void 0 ? init : {}, SETTINGS);
    if (!response.ok) {
        let detail = response.statusText;
        try {
            const data = await response.json();
            detail = (data === null || data === void 0 ? void 0 : data.error) || detail;
        }
        catch (_a) {
            /* 保持 statusText */
        }
        throw new ServerConnection.ResponseError(response, detail);
    }
    return response.json();
}
/** GET 请求。 */
export function apiGet(path) {
    return requestAPI(path);
}
/** POST 请求（JSON body）。 */
export function apiPost(path, body) {
    return requestAPI(path, {
        method: 'POST',
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
}
/** PUT 请求（JSON body）。 */
export function apiPut(path, body) {
    return requestAPI(path, {
        method: 'PUT',
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
}
/** DELETE 请求。 */
export function apiDelete(path, body) {
    return requestAPI(path, {
        method: 'DELETE',
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
}
/**
 * SSE 聊天流（自动带 XSRF 认证）。
 * 逐事件回调；返回取消函数。
 */
export function streamChat(payload, onEvent, onError, onDone, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) {
        if (signal.aborted) {
            controller.abort();
        }
        else {
            signal.addEventListener('abort', abort, { once: true });
        }
    }
    ServerConnection.makeRequest(apiUrl('chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
    }, SETTINGS)
        .then(async (response) => {
        var _a;
        if (!response.ok) {
            let detail = response.statusText;
            try {
                const data = await response.json();
                detail = (data === null || data === void 0 ? void 0 : data.error) || detail;
            }
            catch (_b) {
                /* ignore */
            }
            throw new Error(detail);
        }
        const reader = (_a = response.body) === null || _a === void 0 ? void 0 : _a.getReader();
        if (!reader) {
            throw new Error('响应无内容');
        }
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            // 解析 SSE 事件（data: {...}\n\n）
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                for (const line of raw.split('\n')) {
                    if (!line.startsWith('data:')) {
                        continue;
                    }
                    const dataStr = line.slice(5).trim();
                    if (!dataStr) {
                        continue;
                    }
                    try {
                        const ev = JSON.parse(dataStr);
                        onEvent(ev);
                    }
                    catch (_c) {
                        /* 忽略无法解析的事件 */
                    }
                }
            }
        }
    })
        .catch(err => {
        if ((err === null || err === void 0 ? void 0 : err.name) === 'AbortError') {
            return;
        }
        onError(err instanceof Error ? err : new Error(String(err)));
    })
        .finally(() => {
        onDone();
    });
    return abort;
}

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
export function apiUrl(path: string): string {
  return URLExt.join(SETTINGS.baseUrl, 'cbhcli/api', path);
}

/** 发起 JSON 请求并解析响应（自动带 XSRF 认证）。 */
export async function requestAPI<T = any>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await ServerConnection.makeRequest(
    apiUrl(path),
    init ?? {},
    SETTINGS
  );
  if (!response.ok) {
    let detail: string = response.statusText;
    try {
      const data = await response.json();
      detail = data?.error || detail;
    } catch {
      /* 保持 statusText */
    }
    throw new ServerConnection.ResponseError(response, detail);
  }
  return response.json();
}

/** GET 请求。 */
export function apiGet<T = any>(path: string): Promise<T> {
  return requestAPI<T>(path);
}

/** POST 请求（JSON body）。 */
export function apiPost<T = any>(path: string, body?: any): Promise<T> {
  return requestAPI<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

/** PUT 请求（JSON body）。 */
export function apiPut<T = any>(path: string, body?: any): Promise<T> {
  return requestAPI<T>(path, {
    method: 'PUT',
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

/** DELETE 请求。 */
export function apiDelete<T = any>(path: string, body?: any): Promise<T> {
  return requestAPI<T>(path, {
    method: 'DELETE',
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

/**
 * SSE 聊天流（自动带 XSRF 认证）。
 * 逐事件回调；返回取消函数。
 */
export function streamChat(
  payload: {
    agent_name: string;
    model_name: string;
    message: string;
    images?: string[];
    cwd?: string;
    /** 小眼睛严格模式：仅当注入了选区上下文时为 true，后端据此启用/禁用 nb 工具 */
    nb_enabled?: boolean;
  },
  onEvent: (ev: any) => void,
  onError: (err: Error) => void,
  onDone: () => void,
  signal?: AbortSignal
): () => void {
  const controller = new AbortController();
  // v0.3.2：标记是否为我们主动中断。ServerConnection.makeRequest 会把 fetch 的
  // 拒绝（含主动 abort）包装成 NetworkError extends TypeError（name 不再是
  // 'AbortError'，message 为 "signal is aborted without reason"），仅靠
  // err.name === 'AbortError' 判断会漏掉 -> 误报 "❌ 连接错误"。
  let abortedByUs = false;
  const abort = () => {
    abortedByUs = true;
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }

  ServerConnection.makeRequest(
    apiUrl('chat'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    },
    SETTINGS
  )
    .then(async response => {
      if (!response.ok) {
        let detail: string = response.statusText;
        try {
          const data = await response.json();
          detail = data?.error || detail;
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      const reader = response.body?.getReader();
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
        let idx: number;
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
            } catch {
              /* 忽略无法解析的事件 */
            }
          }
        }
      }
    })
    .catch(err => {
      // 主动中断不算错误：三重判定（本地标记 / AbortError 名称 / 中断消息）
      if (
        abortedByUs ||
        err?.name === 'AbortError' ||
        /signal is aborted|user aborted/i.test(String(err?.message || ''))
      ) {
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    })
    .finally(() => {
      onDone();
    });

  return abort;
}

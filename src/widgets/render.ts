/**
 * 渲染模块：对齐 cbhcli Web 界面（markdown / 语法高亮 / 代码复制 / 工具 diff / ANSI 清理）。
 * 移植自 cbhcli_pkg/web/static/js/app.js。
 */

import { marked } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// ---------------------------------------------------------------------------
//  基础工具
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 去除 ANSI 转义序列（终端/工具输出可能携带颜色码，如 \x1b[36m）。 */
export function stripAnsi(s: any): string {
  return String(s ?? '').replace(
    /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([0-9A-B]|[=>#][0-9]?)/g,
    ''
  );
}

/** 复制文本到剪贴板（兼容非安全上下文）。 */
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
    if (ok) {
      resolve();
    } else {
      reject(new Error('复制失败'));
    }
  });
}

// ---------------------------------------------------------------------------
//  Markdown 渲染（marked，支持表格/代码块/列表等）
// ---------------------------------------------------------------------------

marked.setOptions({ gfm: true, breaks: true });

// ---------------------------------------------------------------------------
//  LaTeX 公式渲染（KaTeX，v0.2.12）
//  渲染正文中的 $$...$$ / \[...\] 块级 与 $...$ / \(...\) 行内公式。
//  所有代码块（```，含 ```latex/math/tex）与行内代码（`）一律保护为代码，不渲染公式。
// ---------------------------------------------------------------------------

interface MathSeg {
  tex: string;
  display: boolean;
}

/** 用 KaTeX 把 TeX 渲染为 HTML；失败时回退为原始文本（不抛错）。 */
function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      output: 'html'
    });
  } catch {
    return escapeHtml((display ? '$$' : '$') + tex + (display ? '$$' : '$'));
  }
}

/** 单遍扫描：保护代码块/行内代码，把公式抽成占位符（避免 marked 破坏 _ * 等符号）。
 * 所有围栏代码块（含 ```latex/math/tex）与行内代码内的 $ 一律不渲染，原样保留为代码。 */
function extractMath(text: string, maths: MathSeg[]): string {
  // 优先级：围栏代码块 > 行内代码 > $$块级 > \[块级\] > $行内 > \(行内\)
  const re =
    /(```[\s\S]*?```|~~~[\s\S]*?~~~)|(`[^`\n]*`)|(\$\$[\s\S]+?\$\$)|(\\\[[\s\S]+?\\\])|(\$[^\s$`][^$\n]*?[^\s$`]\$|\$[^\s$`]\$)|(\\\(.+?\\\))/g;
  return text.replace(re, (m, fence, inlineCode, dispA, dispB, inlA, inlB) => {
    if (fence !== undefined || inlineCode !== undefined) {
      return m; // 代码原样保留，交给 marked
    }
    let tex = '';
    let display = false;
    if (dispA !== undefined) {
      tex = dispA.slice(2, -2);
      display = true;
    } else if (dispB !== undefined) {
      tex = dispB.slice(2, -2);
      display = true;
    } else if (inlA !== undefined) {
      tex = inlA.slice(1, -1);
      display = false;
    } else if (inlB !== undefined) {
      tex = inlB.slice(2, -2);
      display = false;
    } else {
      return m;
    }
    maths.push({ tex: tex.trim(), display });
    const ph = `@@CBHMATH${maths.length - 1}@@`;
    return display ? `\n\n${ph}\n\n` : ph;
  });
}

export function renderMarkdown(text: string): string {
  if (!text) {
    return '';
  }
  try {
    const maths: MathSeg[] = [];
    const prepared = extractMath(text, maths);
    let html = marked.parse(prepared) as string;
    if (maths.length) {
      // 还原占位符：块级连同外层 <p> 一起替换为 div，行内替换为 span
      html = html.replace(/(<p>)?@@CBHMATH(\d+)@@(<\/p>)?/g, (m, _p, idx) => {
        const seg = maths[Number(idx)];
        if (!seg) {
          return m;
        }
        const rendered = renderTex(seg.tex, seg.display);
        return seg.display
          ? `<div class="cbh-math-block">${rendered}</div>`
          : `<span class="cbh-math-inline">${rendered}</span>`;
      });
    }
    return sanitizeHtml(html);
  } catch {
    return escapeHtml(text);
  }
}

// ---------------------------------------------------------------------------
//  Mermaid / ECharts 图表渲染（v0.2.13）
//  流式中 ```mermaid / ```echarts 代码块按代码显示，回复完成或恢复历史时调用
//  renderDiagrams 原地替换为 SVG / ECharts 图表。渲染失败一律保留代码块。
//  动态 import 懒加载（webpack 代码分割），纯前端离线渲染，无 Python 依赖。
// ---------------------------------------------------------------------------

let _mermaidMod: any = null;
let _mermaidLoading: Promise<any> | null = null;
let _mermaidInited = false;
let _diagSeq = 0;
const _mermaidSvgCache = new Map<string, string>();

async function getMermaid(): Promise<any | null> {
  if (_mermaidMod) return _mermaidMod;
  if (!_mermaidLoading) {
    _mermaidLoading = import('mermaid')
      .then(m => {
        _mermaidMod = (m as any).default || m;
        return _mermaidMod;
      })
      .catch(e => {
        console.error('加载 mermaid 失败:', e);
        return null;
      });
  }
  return _mermaidLoading;
}

async function getEcharts(): Promise<any | null> {
  try {
    return await import('echarts');
  } catch (e) {
    console.error('加载 echarts 失败:', e);
    return null;
  }
}

/** 解析 echarts option：JSON 优先 → JS 求值兜底（函数/尾逗号）→ "option = {...}" 形式。 */
function parseEchartsOption(src: string): any | null {
  const s = String(src).trim().replace(/;+\s*$/, ''); // 去尾部多余分号
  try {
    return JSON.parse(s);
  } catch {
    /* 继续 */
  }
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return (' + s + ')')();
  } catch {
    /* 继续 */
  }
  const m = s.match(/^(?:var|let|const)?\s*[A-Za-z_$][\w$]*\s*=\s*([\s\S]+)$/);
  if (m) {
    try {
      // eslint-disable-next-line no-new-func
      return new Function('return (' + m[1] + ')')();
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 判断解析结果是否像 echarts option（含 series，echarts 的强特征）。 */
function looksLikeEcharts(opt: any): boolean {
  return (
    !!opt &&
    typeof opt === 'object' &&
    !Array.isArray(opt) &&
    'series' in opt &&
    (Array.isArray(opt.series) || (opt.series && typeof opt.series === 'object'))
  );
}

/** 收集 echarts 代码块：显式 echarts/echart 标签，或 json/javascript/js 标签且内容像 echarts option。 */
function collectEchartsBlocks(container: HTMLElement): Array<{ pre: HTMLElement; src: string }> {
  const blocks: Array<{ pre: HTMLElement; src: string }> = [];
  container.querySelectorAll<HTMLElement>('pre code').forEach(code => {
    const pre = code.closest('pre') as HTMLElement | null;
    if (!pre || pre.dataset.diagDone) return;
    const m = (code.className || '').match(/language-([\w+#-]+)/);
    const lang = m ? m[1].toLowerCase() : '';
    const src = (code.textContent || '').trim();
    if (!src) return;
    if (lang === 'echarts' || lang === 'echart') {
      blocks.push({ pre, src });
    } else if (lang === 'json' || lang === 'javascript' || lang === 'js') {
      if (looksLikeEcharts(parseEchartsOption(src))) blocks.push({ pre, src });
    }
  });
  return blocks;
}

/** mermaid 安全渲染：清理残留临时元素 + 失败重试一次，成功结果按源码缓存。 */
async function renderMermaidSafe(mermaid: any, src: string): Promise<string> {
  if (_mermaidSvgCache.has(src)) return _mermaidSvgCache.get(src) as string;
  const id = 'cbh-mmd-' + ++_diagSeq;
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      document.getElementById(id)?.remove();
      document.getElementById('d' + id)?.remove();
      const out = await mermaid.render(id, src);
      if (out && out.svg) {
        _mermaidSvgCache.set(src, out.svg);
        return out.svg;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('mermaid render 无输出');
}

/** 构建「图片 / 代码」切换包装器；onShowImg 在切回图片视图时回调（echarts 需 resize）。 */
function buildDiagramWrap(
  src: string,
  onShowImg?: () => void
): { wrap: HTMLElement; imgView: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.className = 'cbh-diagram-wrap';

  const btnImg = document.createElement('button');
  btnImg.className = 'cbh-diagram-tab active';
  btnImg.type = 'button';
  btnImg.textContent = '图片';
  const btnCode = document.createElement('button');
  btnCode.className = 'cbh-diagram-tab';
  btnCode.type = 'button';
  btnCode.textContent = '代码';
  const toolbar = document.createElement('div');
  toolbar.className = 'cbh-diagram-toolbar';
  toolbar.appendChild(btnImg);
  toolbar.appendChild(btnCode);

  const imgView = document.createElement('div');
  imgView.className = 'cbh-diagram-view cbh-diagram-img';
  const codeView = document.createElement('div');
  codeView.className = 'cbh-diagram-view cbh-diagram-code';
  const codeEl = document.createElement('code');
  codeEl.textContent = src;
  const preEl = document.createElement('pre');
  preEl.appendChild(codeEl);
  preEl.appendChild(makeCopyBtn(src));
  codeView.appendChild(preEl);
  codeView.style.display = 'none';

  wrap.appendChild(toolbar);
  wrap.appendChild(imgView);
  wrap.appendChild(codeView);

  const show = (img: boolean): void => {
    imgView.style.display = img ? '' : 'none';
    codeView.style.display = img ? 'none' : '';
    btnImg.classList.toggle('active', img);
    btnCode.classList.toggle('active', !img);
    if (img && onShowImg) {
      try {
        onShowImg();
      } catch {
        /* 忽略 */
      }
    }
  };
  btnImg.addEventListener('click', () => show(true));
  btnCode.addEventListener('click', () => show(false));
  return { wrap, imgView };
}

export async function renderDiagrams(container: HTMLElement): Promise<void> {
  if (!container) return;

  // ---- mermaid ----
  const mmdBlocks: Array<{ pre: HTMLElement; src: string }> = [];
  container.querySelectorAll<HTMLElement>('pre code.language-mermaid').forEach(code => {
    const pre = code.closest('pre') as HTMLElement | null;
    if (!pre || pre.dataset.diagDone) return;
    const src = (code.textContent || '').trim();
    if (src) mmdBlocks.push({ pre, src });
  });
  if (mmdBlocks.length) {
    const mermaid = await getMermaid();
    if (mermaid) {
      if (!_mermaidInited) {
        try {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'strict', // 内置 DOMPurify 消毒，防 XSS
            logLevel: 'fatal'
          });
          _mermaidInited = true;
        } catch (e) {
          console.error('mermaid initialize 失败:', e);
        }
      }
      for (const { pre, src } of mmdBlocks) {
        if (!pre.isConnected) continue;
        pre.dataset.diagDone = '1';
        try {
          const svg = await renderMermaidSafe(mermaid, src);
          const { wrap, imgView } = buildDiagramWrap(src);
          imgView.classList.add('cbh-mermaid');
          imgView.innerHTML = svg;
          pre.replaceWith(wrap);
        } catch (e) {
          console.warn('mermaid 渲染失败，保留代码块:', e);
        }
      }
    }
  }

  // ---- echarts ----
  const ecBlocks = collectEchartsBlocks(container);
  if (ecBlocks.length) {
    const echarts = await getEcharts();
    if (echarts) {
      for (const { pre, src } of ecBlocks) {
        if (!pre.isConnected) continue;
        pre.dataset.diagDone = '1';
        const option = parseEchartsOption(src);
        if (!looksLikeEcharts(option)) {
          console.warn('echarts option 解析失败，保留代码块');
          continue;
        }
        try {
          let chart: any = null;
          const { wrap, imgView } = buildDiagramWrap(src, () => {
            if (chart) chart.resize();
          });
          const box = document.createElement('div');
          box.className = 'cbh-echarts';
          imgView.appendChild(box);
          pre.replaceWith(wrap);
          chart = echarts.init(box, 'dark');
          chart.setOption(option);
          if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
              try {
                chart.resize();
              } catch {
                /* 忽略 */
              }
            });
            ro.observe(box);
          }
        } catch (e) {
          console.warn('echarts 渲染失败:', e);
        }
      }
    }
  }
}

/** 简易 HTML 净化：移除 script/事件属性/危险协议。 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

// ---------------------------------------------------------------------------
//  轻量语法高亮（monokai 配色，离线零依赖，移植自 web）
// ---------------------------------------------------------------------------

const HL_KEYWORDS: { [k: string]: string[] } = {
  python: (
    'and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return ' +
    'try while with yield True False None self cls'
  ).split(' '),
  javascript: (
    'const let var function return if else for while do break continue switch ' +
    'case default try catch finally throw new delete typeof instanceof in of class extends ' +
    'super this null undefined true false async await yield import export from static get set'
  ).split(' '),
  bash: (
    'if then else elif fi for while until do done case esac function in select echo ' +
    'cd ls pwd mkdir rm cp mv cat grep sed awk find chmod chown sudo apt pip pip3 npm node ' +
    'python python3 git curl wget tar source export local declare read exit return kill'
  ).split(' '),
  sql: (
    'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP ' +
    'INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT ' +
    'NULL IN EXISTS BETWEEN LIKE UNION ALL DISTINCT CASE WHEN THEN ELSE END'
  ).split(' ')
};
HL_KEYWORDS.python.push('print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict',
  'set', 'tuple', 'type', 'isinstance', 'enumerate', 'zip', 'map', 'filter', 'open', 'super');
HL_KEYWORDS.javascript.push('console', 'document', 'window', 'JSON', 'Math', 'Object',
  'Array', 'String', 'Number', 'Promise', 'fetch', 'require', 'module', 'process');

const HL_BUILTINS: { [k: string]: Set<string> } = {
  python: new Set(['print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set',
    'tuple', 'type', 'isinstance', 'enumerate', 'zip', 'map', 'filter', 'open', 'super']),
  javascript: new Set(['console', 'document', 'window', 'JSON', 'Math', 'Object', 'Array',
    'String', 'Number', 'Promise', 'fetch', 'require', 'module', 'process'])
};

const EXT_LANG: { [k: string]: string } = {
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', sql: 'sql', yaml: 'yaml', yml: 'yaml',
  ipynb: 'python', txt: ''
};

export function guessLang(filePath: string): string | null {
  if (!filePath) {
    return null;
  }
  const ext = String(filePath).split('.').pop()?.toLowerCase() || '';
  return EXT_LANG[ext] || null;
}

const HL_MASTER =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|--[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\$[A-Za-z_][\w$]*|\$\{[^}]*\})|([A-Za-z_][\w$]*)|(\s+|.)/g;

export function highlightCode(code: string, lang: string | null): string {
  if (!code) {
    return '';
  }
  let L = (lang || '').toLowerCase();
  if (L === 'py') {
    L = 'python';
  }
  if (['js', 'ts', 'jsx', 'tsx', 'node'].includes(L)) {
    L = 'javascript';
  }
  if (['sh', 'shell', 'zsh', 'shellsession', 'console'].includes(L)) {
    L = 'bash';
  }
  const kwSet = new Set(HL_KEYWORDS[L] || []);
  const biSet = HL_BUILTINS[L] || new Set();
  const isJson = L === 'json';
  const isYaml = L === 'yaml';
  const src = String(code);
  let html = '';
  let last = 0;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls: string, s: string) => `<span class="${cls}">${esc(s)}</span>`;

  HL_MASTER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HL_MASTER.exec(src)) !== null) {
    const [, com, str, num, variable, word] = m;
    const tok = m[0];
    if (com !== undefined) {
      html += span('tok-com', tok);
    } else if (str !== undefined) {
      if (isJson) {
        const rest = src.slice(HL_MASTER.lastIndex).match(/^\s*:/);
        html += span(rest ? 'tok-attr' : 'tok-str', tok);
      } else {
        html += span('tok-str', tok);
      }
    } else if (num !== undefined) {
      html += span('tok-num', tok);
    } else if (variable !== undefined) {
      html += span('tok-var', tok);
    } else if (word !== undefined) {
      if (isJson && /^(true|false|null)$/.test(tok)) {
        html += span('tok-kw', tok);
      } else if (isYaml) {
        const rest = src.slice(HL_MASTER.lastIndex).match(/^\s*:/);
        html += span(rest ? 'tok-attr' : 'tok-op', tok);
      } else if (kwSet.has(tok) || (L === 'sql' && kwSet.has(tok.toUpperCase()))) {
        html += span(biSet.has(tok) ? 'tok-bi' : 'tok-kw', tok);
      } else if (biSet.has(tok)) {
        html += span('tok-bi', tok);
      } else if (src[HL_MASTER.lastIndex] === '(') {
        html += span('tok-func', tok);
      } else {
        html += esc(tok);
      }
    } else {
      html += esc(tok);
    }
    last = HL_MASTER.lastIndex;
    if (m[0] === '') {
      HL_MASTER.lastIndex++;
    }
  }
  html += esc(src.slice(last));
  return html;
}

// ---------------------------------------------------------------------------
//  DOM 构造辅助
// ---------------------------------------------------------------------------

function mkEl(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

/** 代码块元素（带语法高亮 + 复制按钮 + 可选标签）。 */
export function codeBlockEl(code: string, lang: string | null, labelText?: string): HTMLElement {
  const wrap = mkEl('div', 'cbh-tool-code');
  if (labelText) {
    wrap.appendChild(mkEl('div', 'cbh-tool-code-label', labelText));
  }
  const pre = mkEl('pre', 'cbh-code-pre');
  const codeEl = mkEl('code');
  codeEl.innerHTML = highlightCode(code || '', lang);
  (codeEl as any).dataset.raw = code || '';
  pre.appendChild(codeEl);
  pre.appendChild(makeCopyBtn(code || ''));
  wrap.appendChild(pre);
  return wrap;
}

/** 复制按钮。 */
function makeCopyBtn(text: string): HTMLElement {
  const btn = mkEl('button', 'cbh-code-copy-btn', '复制');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    copyText(text)
      .then(() => {
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1200);
      })
      .catch(() => {
        btn.textContent = '复制失败';
        setTimeout(() => (btn.textContent = '复制'), 1200);
      });
  });
  return btn;
}

/** 为已渲染的 markdown 容器中的代码块补上高亮 + 复制按钮。 */
export function enhanceCodeBlocks(container: HTMLElement): void {
  container.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (code && !(code as any).dataset.hlDone) {
      (code as any).dataset.hlDone = '1';
      const raw = code.textContent || '';
      (code as any).dataset.raw = raw;
      const langMatch = (code.className || '').match(/language-([\w+-]+)/);
      code.innerHTML = highlightCode(raw, langMatch ? langMatch[1] : null);
    }
    if (!pre.querySelector('.cbh-code-copy-btn')) {
      const codeText = pre.querySelector('code')?.textContent || pre.textContent || '';
      pre.appendChild(makeCopyBtn(codeText));
    }
  });
}

// ---------------------------------------------------------------------------
//  diff（edit 工具）：行内字符级对比，仅变更部分着色
// ---------------------------------------------------------------------------

export function diffBlockEl(
  oldStr: string,
  newStr: string,
  lang: string | null,
  labelText?: string
): HTMLElement {
  const wrap = mkEl('div');
  if (labelText) {
    wrap.appendChild(mkEl('div', 'cbh-tool-code-label', labelText));
  }
  const block = mkEl('div', 'cbh-diff-block');
  const oldLines = String(oldStr ?? '').split('\n');
  const newLines = String(newStr ?? '').split('\n');
  const escHl = (s: string) => highlightCode(s, lang);

  const renderRow = (sign: string, segs: { text: string; hl: boolean }[], cls: string): HTMLElement => {
    const row = mkEl('div', `cbh-diff-line ${cls}`);
    row.appendChild(mkEl('span', 'cbh-diff-sign', sign));
    for (const seg of segs) {
      if (!seg.text) {
        continue;
      }
      const sp = mkEl('span', seg.hl ? (cls === 'del' ? 'cbh-diff-hl-del' : 'cbh-diff-hl-add') : '');
      sp.innerHTML = escHl(seg.text);
      row.appendChild(sp);
    }
    if (!segs.some(s => s.text)) {
      row.insertAdjacentHTML('beforeend', '&nbsp;');
    }
    return row;
  };

  const inlineDiff = (a: string, b: string) => {
    let pre = 0;
    const maxPre = Math.min(a.length, b.length);
    while (pre < maxPre && a[pre] === b[pre]) {
      pre++;
    }
    let sufA = a.length;
    let sufB = b.length;
    while (sufA > pre && sufB > pre && a[sufA - 1] === b[sufB - 1]) {
      sufA--;
      sufB--;
    }
    return {
      aSegs: [
        { text: a.slice(0, pre), hl: false },
        { text: a.slice(pre, sufA), hl: true },
        { text: a.slice(sufA), hl: false }
      ],
      bSegs: [
        { text: b.slice(0, pre), hl: false },
        { text: b.slice(pre, sufB), hl: true },
        { text: b.slice(sufB), hl: false }
      ]
    };
  };

  let preLines = 0;
  const maxPreLines = Math.min(oldLines.length, newLines.length);
  while (preLines < maxPreLines && oldLines[preLines] === newLines[preLines]) {
    preLines++;
  }
  let sufLines = 0;
  while (
    sufLines < maxPreLines - preLines &&
    oldLines[oldLines.length - 1 - sufLines] === newLines[newLines.length - 1 - sufLines]
  ) {
    sufLines++;
  }

  for (let i = 0; i < preLines; i++) {
    block.appendChild(renderRow(' ', [{ text: oldLines[i], hl: false }], 'ctx'));
  }
  const oldMid = oldLines.slice(preLines, oldLines.length - sufLines);
  const newMid = newLines.slice(preLines, newLines.length - sufLines);
  if (oldMid.length === newMid.length) {
    for (let i = 0; i < oldMid.length; i++) {
      const { aSegs, bSegs } = inlineDiff(oldMid[i], newMid[i]);
      block.appendChild(renderRow('-', aSegs, 'del'));
      block.appendChild(renderRow('+', bSegs, 'add'));
    }
  } else {
    for (const line of oldMid) {
      block.appendChild(renderRow('-', [{ text: line, hl: true }], 'del'));
    }
    for (const line of newMid) {
      block.appendChild(renderRow('+', [{ text: line, hl: true }], 'add'));
    }
  }
  for (let i = oldLines.length - sufLines; i < oldLines.length; i++) {
    block.appendChild(renderRow(' ', [{ text: oldLines[i], hl: false }], 'ctx'));
  }
  wrap.appendChild(block);
  return wrap;
}

// ---------------------------------------------------------------------------
//  Todo 任务面板（对齐 web：直接展示任务事项，不显示 JSON）
// ---------------------------------------------------------------------------

/** Todo 参数防御性解析（模型可能传 JSON 字符串/嵌套对象/非数组）。 */
export function normalizeTodos(args: any): { content: string; status: string }[] {
  let t = args && args.todos !== undefined ? args.todos : args;
  if (typeof t === 'string') {
    try {
      t = JSON.parse(t);
    } catch {
      t = [];
    }
  }
  if (t && !Array.isArray(t) && Array.isArray(t.todos)) {
    t = t.todos;
  }
  if (!Array.isArray(t)) {
    return [];
  }
  const out: { content: string; status: string }[] = [];
  for (const item of t) {
    if (typeof item === 'string') {
      if (item) {
        out.push({ content: item, status: 'pending' });
      }
    } else if (item && typeof item === 'object') {
      const content = String(item.content ?? item.task ?? item.title ?? '');
      if (content) {
        out.push({ content, status: String(item.status || 'pending') });
      }
    }
  }
  return out;
}

/** Todo 任务面板元素（📋 标题 + done/total + 每项 ✓/◐/○ 标记）。 */
export function todoPanelEl(todos: { content: string; status: string }[]): HTMLElement {
  const panel = mkEl('div', 'cbhcli-todo-panel');
  const done = todos.filter(t => t.status === 'completed').length;
  const header = mkEl('div', 'cbhcli-todo-panel-header');
  header.appendChild(mkEl('span', '', '📋 任务计划'));
  header.appendChild(mkEl('span', 'cbhcli-todo-panel-count', `${done}/${todos.length}`));
  panel.appendChild(header);
  for (const t of todos) {
    const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : '';
    const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○';
    const item = mkEl('div', `cbhcli-todo-item ${cls}`.trim());
    item.appendChild(mkEl('span', 'mark', mark));
    item.appendChild(mkEl('span', 'cbhcli-todo-text', t.content));
    panel.appendChild(item);
  }
  return panel;
}

// ---------------------------------------------------------------------------
//  工具参数渲染（edit/write/python/terminal/read 等，与 web 对齐）
// ---------------------------------------------------------------------------

export function renderToolArgs(container: HTMLElement, name: string, args: any): void {
  args = args || {};
  switch (name) {
    case 'Todo':
      // Todo 不在工具卡片内展示参数，由专用任务面板直接呈现（见 chatPanel）
      break;
    case 'python':
      container.appendChild(codeBlockEl(args.code || '', 'python', '🐍 Python'));
      break;
    case 'terminal':
      container.appendChild(codeBlockEl(args.command || '', 'bash', '$ 终端命令'));
      break;
    case 'write': {
      const fp = args.file_path || '';
      container.appendChild(codeBlockEl(args.content || '', guessLang(fp), `📝 ${fp}`));
      break;
    }
    case 'edit': {
      const fp = args.file_path || '';
      container.appendChild(
        diffBlockEl(args.old_str || '', args.new_str || '', guessLang(fp), `✏️ ${fp}`)
      );
      break;
    }
    case 'read': {
      const fp = args.file_path || '';
      let info = `📄 ${fp}`;
      if (args.start_line || args.end_line) {
        info += `  (第 ${args.start_line || 1} - ${args.end_line || '末尾'} 行)`;
      }
      const box = mkEl('div', 'cbh-tool-code');
      box.appendChild(mkEl('div', 'cbh-tool-code-label', info));
      container.appendChild(box);
      break;
    }
    case 'grep':
      container.appendChild(
        codeBlockEl(`/${args.pattern || ''}/  in  ${args.path || '.'}`, null, '🔍 正则搜索')
      );
      break;
    case 'glob':
      container.appendChild(codeBlockEl(args.pattern || '', null, '📁 文件匹配'));
      break;
    default: {
      const s = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
      if (s && s !== '{}' && s !== '""') {
        container.appendChild(mkEl('div', 'cbh-tool-section-label', '参数'));
        const pre = mkEl('pre', 'cbh-tool-args');
        pre.textContent = s.length > 600 ? s.slice(0, 600) + '…' : s;
        container.appendChild(pre);
      }
    }
  }
}

/** 渲染工具结果输出（去 ANSI；python/terminal 输出用等宽块）。 */
export function renderToolResult(container: HTMLElement, name: string, preview: string, okFlag: boolean): void {
  const text = stripAnsi(preview);
  if (!text.trim()) {
    return;
  }
  container.appendChild(mkEl('div', 'cbh-tool-section-label', okFlag ? '结果' : '错误'));
  const pre = mkEl('pre', `cbh-term-output ${okFlag ? '' : 'fail'}`);
  const trimmed = text.length > 2000 ? text.slice(0, 2000) + `\n… [已截断 ${text.length} 字符]` : text;
  pre.textContent = trimmed;
  container.appendChild(pre);
}

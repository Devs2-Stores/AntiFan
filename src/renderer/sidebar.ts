/**
 * AntiFan Browser Desktop — AI Chat Sidebar Renderer
 * 100% Antigravity IDE UI Parity:
 * - Authentic Dark Theme & Markdown Renderer
 * - Single-line Compact Tool Calls & Thinking blocks
 * - Multi-IDE Session Selector Dropdown & Project Rename
 * - Ctrl+V Image & File Paste Attachment
 * - Autocomplete Menu for /skills and @agents
 * - Draggable Left-edge Resizer
 */

interface ChatToolCall {
  id: string;
  name: string;
  args?: Record<string, any>;
  result?: any;
  status?: 'running' | 'done' | 'failed';
}

interface AntiFanPickedElement {
  tag: string;
  id?: string;
  classes: string[];
  textSnippet: string;
  xpath: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  fontFamily?: string;
  fontSize?: string;
  color?: string;
  backgroundColor?: string;
  screenshotBase64?: string;
  userComment?: string;
  markdownPath?: string;
  timestamp: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  attachedElement?: AntiFanPickedElement;
  attachedImages?: Array<{ name: string; dataUrl: string }>;
  timestamp: number;
}

interface AntiFanSidebarApi {
  getInitialState: () => Promise<any>;
  sendPrompt: (text: string, attachedElement?: any, attachedImages?: any, deliveryMode?: 'auto' | 'draft', sessionId?: string) => Promise<any>;
  abortGeneration: (sessionId?: string) => Promise<{ ok: boolean }>;
  getAutocompleteItems: () => Promise<Array<{ tag: string; desc: string; type?: string }>>;
  clearHistory: () => Promise<void>;
  closeSidebar: () => Promise<void>;
  setWidth: (width: number) => Promise<void>;
  getSessions: () => Promise<{ sessions: any[]; activeSessionId: string }>;
  switchSession: (sessionId: string) => Promise<{ ok: boolean; messages: ChatMessage[] }>;
  renameSession: (sessionId: string, newTitle: string) => Promise<{ ok: boolean; sessions: any[] }>;
  deleteSession: (sessionId: string) => Promise<{ ok: boolean; sessions: any[]; messages: ChatMessage[] }>;
  onStreamUpdate: (callback: (data: any) => void) => () => void;
  onSessionChanged: (callback: (data: any) => void) => () => void;
  onAttachElement: (callback: (element: any) => void) => () => void;
}

declare global {
  interface Window {
    antifanSidebar?: AntiFanSidebarApi;
  }
}

function getApi(): AntiFanSidebarApi | undefined {
  return window.antifanSidebar;
}

let messages: ChatMessage[] = [];
let currentAttachedElement: AntiFanPickedElement | null = null;
let currentPastedImages: Array<{ name: string; dataUrl: string }> = [];
const userExpandedWorkMap: Record<string, boolean> = {};

// DOM Elements
const sidebarRoot = document.getElementById('sidebar-root')!;
const sidebarResizer = document.getElementById('sidebarResizer')!;
const btnSessionPill = document.getElementById('btnSessionPill')!;
const pillStatusDot = document.getElementById('pillStatusDot')!;
const pillTitle = document.getElementById('pillTitle')!;
const sessionMenuDropdown = document.getElementById('sessionMenuDropdown')!;
const sessionSearchInput = document.getElementById('sessionSearchInput') as HTMLInputElement;
const sessionFilterChips = document.getElementById('sessionFilterChips')!;
const sessionListItems = document.getElementById('sessionListItems')!;
const renameModal = document.getElementById('renameModal')!;
const renameInput = document.getElementById('renameInput') as HTMLInputElement;
const btnSaveRename = document.getElementById('btnSaveRename')!;
const btnCancelRename = document.getElementById('btnCancelRename')!;
const deleteModal = document.getElementById('deleteModal')!;
const btnConfirmDelete = document.getElementById('btnConfirmDelete')!;
const btnCancelDelete = document.getElementById('btnCancelDelete')!;
const messagesContainer = document.getElementById('messagesContainer')!;
const emptyState = document.getElementById('emptyState')!;
const attachedElementCard = document.getElementById('attachedElementCard')!;
const elementThumb = document.getElementById('elementThumb')!;
const elementTag = document.getElementById('elementTag')!;
const elementMeta = document.getElementById('elementMeta')!;
const btnRemoveElement = document.getElementById('btnRemoveElement')!;
const pastedImagesRow = document.getElementById('pastedImagesRow')!;
const autocompleteMenu = document.getElementById('autocompleteMenu')!;
const deliveryModeSelect = document.getElementById('deliveryModeSelect') as HTMLSelectElement;
const messageQueueCard = document.getElementById('messageQueueCard')!;
const queueCount = document.getElementById('queueCount')!;
const queueList = document.getElementById('queueList')!;
const btnClearQueue = document.getElementById('btnClearQueue')!;
const btnForceSendAll = document.getElementById('btnForceSendAll')!;

interface QueuedItem {
  id: string;
  text: string;
  attachedElement?: AntiFanPickedElement | null;
  attachedImages?: Array<{ name: string; dataUrl: string }>;
  targetSession?: string;
  deliveryMode?: string;
  timestamp: number;
}

function saveQueueToStorage() {
  try {
    localStorage.setItem('antifan_message_queue', JSON.stringify(messageQueue));
  } catch (err) {
    console.warn('[antifan sidebar] Failed to save queue to localStorage:', err);
  }
}

function loadQueueFromStorage(): QueuedItem[] {
  try {
    const saved = localStorage.getItem('antifan_message_queue');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[antifan sidebar] Failed to load queue from localStorage:', err);
  }
  return [];
}

let messageQueue: QueuedItem[] = loadQueueFromStorage();
let isProcessingQueue = false;
let isAgentWorking = false;

function getSessionQueueItems(): Array<{ item: QueuedItem; realIndex: number }> {
  const result: Array<{ item: QueuedItem; realIndex: number }> = [];
  messageQueue.forEach((item, index) => {
    if (activeSessionId === 'auto' || !item.targetSession || item.targetSession === activeSessionId) {
      result.push({ item, realIndex: index });
    }
  });
  return result;
}

function renderQueueCard() {
  saveQueueToStorage();
  const card = document.getElementById('messageQueueCard');
  if (!card) return;

  const currentItems = getSessionQueueItems();
  if (currentItems.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const countEl = document.getElementById('queueCount');
  if (countEl) countEl.textContent = String(currentItems.length);

  const listEl = document.getElementById('queueList');
  if (listEl) {
    listEl.innerHTML = '';
    currentItems.forEach(({ item, realIndex }, displayIdx) => {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.innerHTML = `
        <span class="queue-item-badge">#${displayIdx + 1}</span>
        <span class="queue-item-text" title="${escapeHtml(item.text)}">${escapeHtml(item.text.slice(0, 50))}${item.text.length > 50 ? '…' : ''}</span>
        <button type="button" class="queue-item-edit" title="Chỉnh sửa tin nhắn này">✏️ Sửa</button>
        <button type="button" class="queue-item-send" title="Gửi ngay bây giờ">⚡ Gửi ngay</button>
        <button type="button" class="queue-item-del" title="Hủy bỏ">&times;</button>
      `;
      const btnEdit = row.querySelector('.queue-item-edit') as HTMLElement | null;
      if (btnEdit) {
        btnEdit.onclick = () => {
          editQueuedItem(realIndex);
        };
      }
      const btnSendNow = row.querySelector('.queue-item-send') as HTMLElement | null;
      if (btnSendNow) {
        btnSendNow.onclick = () => {
          sendQueuedItem(realIndex);
        };
      }
      const btnDel = row.querySelector('.queue-item-del') as HTMLElement | null;
      if (btnDel) {
        btnDel.onclick = () => {
          messageQueue.splice(realIndex, 1);
          renderQueueCard();
        };
      }
      listEl.appendChild(row);
    });
  }
}

function editQueuedItem(realIndex: number) {
  if (realIndex < 0 || realIndex >= messageQueue.length) return;
  const [item] = messageQueue.splice(realIndex, 1);
  if (!item) return;

  renderQueueCard();

  promptInput.value = item.text;
  autoGrowPromptInput();

  if (item.attachedElement) {
    attachElement(item.attachedElement);
  }

  if (Array.isArray(item.attachedImages) && item.attachedImages.length > 0) {
    currentPastedImages = [...item.attachedImages];
    renderPastedImages();
  }

  if (item.deliveryMode && deliveryModeSelect) {
    deliveryModeSelect.value = item.deliveryMode;
  }

  promptInput.focus();
  showSidebarToast('✏️ Đã đưa tin nhắn ra khung soạn thảo để chỉnh sửa', 2000);
}

async function sendQueuedItem(realIndex: number) {
  if (realIndex < 0 || realIndex >= messageQueue.length) return;
  const [item] = messageQueue.splice(realIndex, 1);
  if (!item) return;
  renderQueueCard();
  isAgentWorking = true;
  updateSendButtonState();
  updateSessionDropdown();
  await getApi()?.sendPrompt(item.text, item.attachedElement, item.attachedImages, 'auto', item.targetSession);
}

async function processQueueIfIdle() {
  if (isProcessingQueue || isAgentWorking) return;

  const currentItems = getSessionQueueItems();
  if (currentItems.length === 0) return;

  isProcessingQueue = true;
  const { realIndex } = currentItems[0]!;
  const [nextItem] = messageQueue.splice(realIndex, 1);

  if (nextItem) {
    renderQueueCard();
    isAgentWorking = true;
    updateSendButtonState();
    updateSessionDropdown();
    try {
      await getApi()?.sendPrompt(nextItem.text, nextItem.attachedElement, nextItem.attachedImages, 'auto', nextItem.targetSession);
    } finally {
      isProcessingQueue = false;
    }
  } else {
    isProcessingQueue = false;
  }
}

if (btnClearQueue) {
  btnClearQueue.addEventListener('click', () => {
    if (activeSessionId === 'auto') {
      messageQueue = [];
    } else {
      messageQueue = messageQueue.filter((item) => item.targetSession && item.targetSession !== activeSessionId);
    }
    renderQueueCard();
  });
}

if (btnForceSendAll) {
  btnForceSendAll.addEventListener('click', async () => {
    const currentItems = getSessionQueueItems();
    if (currentItems.length === 0) return;

    for (const { item } of currentItems) {
      await getApi()?.sendPrompt(item.text, item.attachedElement, item.attachedImages, 'auto', item.targetSession);
    }
    if (activeSessionId === 'auto') {
      messageQueue = [];
    } else {
      messageQueue = messageQueue.filter((item) => item.targetSession && item.targetSession !== activeSessionId);
    }
    renderQueueCard();
  });
}

const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const promptInput = document.getElementById('promptInput') as HTMLTextAreaElement;
const btnClear = document.getElementById('btnClear')!;
const btnClose = document.getElementById('btnClose')!;

if (deliveryModeSelect) {
  const savedMode = localStorage.getItem('antifan_delivery_mode') || 'sequential';
  deliveryModeSelect.value = savedMode;
  deliveryModeSelect.addEventListener('change', () => {
    localStorage.setItem('antifan_delivery_mode', deliveryModeSelect.value);
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function highlightCode(rawCode: string, lang: string): string {
  const escaped = escapeHtml(rawCode);
  const l = (lang || '').toLowerCase();

  if (['typescript', 'javascript', 'ts', 'js', 'json', 'node'].includes(l)) {
    let res = escaped;
    res = res.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span style="color:#71717a;font-style:italic">$&</span>');
    res = res.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, '<span style="color:#a5f3fc">$&</span>');
    res = res.replace(/\b(const|let|var|function|return|import|export|from|async|await|if|else|switch|case|break|try|catch|finally|throw|new|this|typeof|instanceof|true|false|null|undefined|interface|type|class|extends|implements|public|private|protected)\b/g, '<span style="color:#f472b6;font-weight:500">$1</span>');
    res = res.replace(/\b(\d+(\.\d+)?)\b/g, '<span style="color:#fde047">$1</span>');
    res = res.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=:)/g, '<span style="color:#93c5fd">$1</span>');
    return res;
  }

  if (['html', 'xml', 'liquid'].includes(l)) {
    let res = escaped.replace(/(&lt;\/?[a-zA-Z0-9_-]+)/g, '<span style="color:#f472b6">$1</span>');
    res = res.replace(/(&gt;)/g, '<span style="color:#f472b6">$1</span>');
    res = res.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '<span style="color:#a5f3fc">$&</span>');
    return res;
  }

  if (['css', 'scss', 'less'].includes(l)) {
    let res = escaped.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '<span style="color:#a5f3fc">$&</span>');
    res = res.replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:#71717a;font-style:italic">$&</span>');
    res = res.replace(/([a-zA-Z_-]+)\s*(?=:)/g, '<span style="color:#93c5fd">$1</span>');
    return res;
  }

  return escaped;
}

function parseMarkdownTables(text: string): { html: string; tables: string[] } {
  const tables: string[] = [];
  const tableRegex = /((?:^|\n)\|[^\n]+\|\r?\n\|[-: |]+\|\r?\n(?:\|[^\n]+\|\r?\n?)+)/g;
  const processed = text.replace(tableRegex, (match) => {
    const rawLines = match.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (rawLines.length < 2) return match;
    const headerLine = rawLines[0];
    const separatorLine = rawLines[1];
    const dataLines = rawLines.slice(2);
    if (!headerLine || !separatorLine) return match;

    const parseRow = (line: string) => {
      let content = line;
      if (content.startsWith('|')) content = content.slice(1);
      if (content.endsWith('|')) content = content.slice(0, -1);
      return content.split('|').map((c) => c.trim());
    };

    const headers = parseRow(headerLine);
    const ths = headers.map((h) => `<th>${h}</th>`).join('');
    const thead = `<thead><tr>${ths}</tr></thead>`;

    const trs = dataLines.map((line) => {
      const cells = parseRow(line);
      const tds = headers.map((_, i) => `<td>${cells[i] !== undefined ? cells[i] : ''}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    const tbody = `<tbody>${trs}</tbody>`;

    const placeholder = `ANTIFANTABLEBLOCK${tables.length}END`;
    tables.push(`<div class="table-container"><table class="md-table">${thead}${tbody}</table></div>`);
    return `\n\n${placeholder}\n\n`;
  });
  return { html: processed, tables };
}

/**
 * Rich Markdown Parser with 100% Antigravity Code Block styling
 */
function renderMarkdown(md: string): string {
  if (!md) return '';

  let html = md.replace(/<truncated \d+ bytes>/g, '');

  // 1. Code blocks with language badge and copy icon
  const codeBlocks: string[] = [];
  html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_match, lang, code) => {
    const placeholder = `ANTIFANBLOCKCODE${codeBlocks.length}END`;
    const trimmedCode = code.trim();
    const rawEscaped = escapeHtml(trimmedCode);
    const highlighted = highlightCode(trimmedCode, lang);
    const langLabel = lang ? lang.toLowerCase() : 'code';
    codeBlocks.push(`
      <div class="code-block">
        <div class="code-header">
          <span class="code-lang">${langLabel}</span>
          <div class="code-actions">
            <button class="code-action-btn copy-btn" title="Copy code" onclick="(function(btn){ navigator.clipboard.writeText(\`${rawEscaped.replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`); btn.innerHTML='<span style=\\'color:#4ade80\\'>✓ Copied</span>'; setTimeout(()=>btn.innerHTML='<svg width=\\'12\\' height=\\'12\\' viewBox=\\'0 0 16 16\\' fill=\\'currentColor\\'><path fill-rule=\\'evenodd\\' d=\\'M4 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z\\'/></svg> Copy', 1500); })(this)">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/></svg>
              <span>Copy</span>
            </button>
          </div>
        </div>
        <pre><code>${highlighted}</code></pre>
      </div>
    `);
    return placeholder;
  });

  // 2. Escape standard HTML in remaining text
  html = escapeHtml(html);

  // 2b. Markdown Tables
  const tableResult = parseMarkdownTables(html);
  html = tableResult.html;

  // 2c. Restore safe inline HTML tags (span style, span class, kbd, mark, br)
  html = html.replace(/&lt;span\s+style=(&quot;|')(.*?)(\1)&gt;(.*?)&lt;\/span&gt;/gi, '<span style="$2">$4</span>');
  html = html.replace(/&lt;span\s+class=(&quot;|')(.*?)(\1)&gt;(.*?)&lt;\/span&gt;/gi, '<span class="$2">$4</span>');
  html = html.replace(/&lt;kbd&gt;(.*?)&lt;\/kbd&gt;/gi, '<kbd class="md-kbd">$1</kbd>');
  html = html.replace(/&lt;mark&gt;(.*?)&lt;\/mark&gt;/gi, '<mark>$1</mark>');
  // 2d. Normalize list bullets at start of lines before processing bold/italics so bullets don't get eaten
  html = html.replace(/^([ \t]*)[*•+](?=\s)/gm, '$1-');

  // 3. Inline code & inline styles
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\S)\*([^*\n]+)\*(?!\S)/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="md-link">$1</a>');

  // 4. Line-by-line block processing
  const lines = html.split('\n');
  const processed: string[] = [];
  let inUl = false;
  let inOl = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Check unordered list item (- , * , • , + )
    const ulMatch = trimmed.match(/^[-*•+]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) {
        processed.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        processed.push('<ul class="md-list">');
        inUl = true;
      }
      processed.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }

    // Check ordered list item (1. , 2. , etc)
    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) {
        processed.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        const startNum = parseInt(olMatch[1] || '1', 10);
        processed.push(`<ol class="md-ol"${startNum > 1 ? ` start="${startNum}"` : ''}>`);
        inOl = true;
      }
      processed.push(`<li>${olMatch[2]}</li>`);
      continue;
    }

    if (inUl) {
      processed.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      processed.push('</ol>');
      inOl = false;
    }

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      processed.push(`<h4>${trimmed.substring(5)}</h4>`);
    } else if (trimmed.startsWith('### ')) {
      processed.push(`<h3>${trimmed.substring(4)}</h3>`);
    } else if (trimmed.startsWith('## ')) {
      processed.push(`<h2>${trimmed.substring(3)}</h2>`);
    } else if (trimmed.startsWith('# ')) {
      processed.push(`<h1>${trimmed.substring(2)}</h1>`);
    } else if (trimmed === '---') {
      processed.push('<hr class="md-hr"/>');
    } else if (trimmed.startsWith('ANTIFANBLOCKCODE') || trimmed.startsWith('<table') || trimmed.startsWith('</div>')) {
      processed.push(line);
    } else {
      processed.push(`<p>${line}</p>`);
    }
  }

  if (inUl) processed.push('</ul>');
  if (inOl) processed.push('</ol>');

  let finalHtml = processed.join('\n');

  // 5. Restore tables
  tableResult.tables.forEach((tableHtml, idx) => {
    finalHtml = finalHtml.split(`ANTIFANTABLEBLOCK${idx}END`).join(tableHtml);
  });

  // 6. Restore code blocks
  codeBlocks.forEach((block, idx) => {
    finalHtml = finalHtml.split(`ANTIFANBLOCKCODE${idx}END`).join(block);
  });

  return finalHtml;
}

const markdownRenderCache = new Map<string, string>();
function getCachedMarkdown(text: string): string {
  if (!text) return '';
  const cached = markdownRenderCache.get(text);
  if (cached) return cached;
  const rendered = renderMarkdown(text);
  if (markdownRenderCache.size > 150) {
    const firstKey = markdownRenderCache.keys().next().value;
    if (firstKey) markdownRenderCache.delete(firstKey);
  }
  markdownRenderCache.set(text, rendered);
  return rendered;
}

function renderThinkingMarkdown(text: string): string {
  if (!text) return '';
  const escaped = escapeHtml(text.trim());

  // 1. Convert bold headers like **Analyzing Lens Zoom Behavior** into styled thinking section titles
  let html = escaped.replace(/\*\*([^*]+)\*\*/g, '<div class="ag-thinking-section-title">$1</div>');

  // 2. Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code class="ag-thinking-code">$1</code>');

  // 3. Bullets / List items
  html = html.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, '<div class="ag-thinking-bullet"><span class="ag-thinking-bullet-dot">•</span> <span>$1</span></div>');

  // 4. Double newlines to paragraph spacers
  html = html.replace(/\n\n+/g, '<div class="ag-thinking-gap"></div>');
  html = html.replace(/\n/g, '<br/>');

  return html;
}

function getBadgeClass(ext: string): string {
  const e = ext.toLowerCase();
  if (['ts', 'tsx'].includes(e)) return 'badge-ts';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(e)) return 'badge-js';
  if (['json', 'jsonl'].includes(e)) return 'badge-json';
  if (['css', 'scss', 'sass', 'less'].includes(e)) return 'badge-css';
  if (['html', 'liquid', 'bwt', 'svg'].includes(e)) return 'badge-html';
  if (['py', 'python'].includes(e)) return 'badge-py';
  if (['sh', 'bash', 'ps1', 'cmd', 'bat'].includes(e)) return 'badge-sh';
  return 'badge-def';
}

/**
 * Renders Antigravity Tool Calls matching IDE Screenshot Single-Line Style
 */
function renderToolSteps(tools: ChatToolCall[]): string {
  if (!tools || tools.length === 0) return '';

  let html = '';
  tools.forEach((tool) => {
    const args = tool.args || {};
    let titleHtml = '';
    let detailContent = '';

    if (tool.name === 'run_command') {
      const rawCmd = args.CommandLine || '';
      const briefCmd = rawCmd.length > 42 ? rawCmd.slice(0, 42) + '...' : rawCmd;
      titleHtml = `<span class="ag-step-prefix">Ran</span> <span class="ag-cmd-pill">${escapeHtml(briefCmd || 'command')}</span>`;
      detailContent = `
        <div class="ag-code-box">
          <span class="ag-code-path">...\\workspace &gt;</span>
          <span class="ag-code-cmd">${escapeHtml(rawCmd)}</span>
        </div>
      `;
    } else if (tool.name === 'view_file' || tool.name === 'read_file') {
      const rawPath = String(args.AbsolutePath || args.path || 'file').replace(/^["']+|["']+$/g, '');
      const fileName = rawPath.split(/[\\/]/).pop() || 'file';
      const cleanFileName = fileName.replace(/^["']+|["']+$/g, '');
      const ext = cleanFileName.includes('.') ? cleanFileName.split('.').pop()!.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : 'FILE';
      const badgeClass = getBadgeClass(ext);
      const lines = args.StartLine ? `<span class="ag-line-range">#L${args.StartLine}-${args.EndLine || ''}</span>` : '';
      titleHtml = `<span class="ag-step-prefix">Analyzed</span> <span class="ag-file-badge ${badgeClass}">${escapeHtml(ext)}</span> <span class="ag-file-name">${escapeHtml(cleanFileName)}</span> ${lines}`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(rawPath)}</div>`;
    } else if (tool.name === 'write_to_file' || tool.name === 'replace_file_content' || tool.name === 'multi_replace_file_content') {
      const rawPath = String(args.TargetFile || args.path || 'file').replace(/^["']+|["']+$/g, '');
      const fileName = rawPath.split(/[\\/]/).pop() || 'file';
      const cleanFileName = fileName.replace(/^["']+|["']+$/g, '');
      const ext = cleanFileName.includes('.') ? cleanFileName.split('.').pop()!.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : 'FILE';
      const badgeClass = getBadgeClass(ext);
      let diffHtml = '';
      if (args.ReplacementContent || args.TargetContent) {
        const addCount = args.ReplacementContent ? args.ReplacementContent.split('\n').length : 1;
        const delCount = args.TargetContent ? args.TargetContent.split('\n').length : 1;
        diffHtml = `<span class="ag-diff-add">+${addCount}</span> <span class="ag-diff-del">-${delCount}</span>`;
      }
      titleHtml = `<span class="ag-step-prefix">Edited</span> <span class="ag-file-badge ${badgeClass}">${escapeHtml(ext)}</span> <span class="ag-file-name">${escapeHtml(cleanFileName)}</span> ${diffHtml}`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">Modified ${escapeHtml(rawPath)}</div>`;
    } else if (tool.name === 'grep_search') {
      titleHtml = `<span class="ag-step-prefix">Explored</span> <span class="ag-file-name">1 file, 1 search</span>`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">Query: ${escapeHtml(args.Query || '')}</div>`;
    } else if (tool.name === 'list_dir') {
      titleHtml = `<span class="ag-step-prefix">Explored</span> <span class="ag-file-name">directory</span>`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(args.DirectoryPath || '')}</div>`;
    } else {
      titleHtml = `<span class="ag-step-prefix">Called</span> <span class="ag-file-name">${escapeHtml(tool.name)}</span>`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;"><pre style="margin:0;font-size:10px;">${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;
    }

    html += `
      <details class="ag-step-details">
        <summary class="ag-step-summary">
          <span class="ag-step-title">${titleHtml}</span>
          <span class="ag-step-arrow">›</span>
        </summary>
        ${detailContent ? `<div class="ag-step-content">${detailContent}</div>` : ''}
      </details>
    `;
  });

  return html;
}

let isUserScrolledUp = false;
let forceScrollToBottom = false;

const btnScrollToBottom = document.getElementById('btnScrollToBottom') as HTMLButtonElement | null;

if (messagesContainer) {
  messagesContainer.addEventListener('scroll', () => {
    const prevScrollTop = messagesContainer.scrollTop;
    const scrollHeight = messagesContainer.scrollHeight;
    const clientHeight = messagesContainer.clientHeight;
    const distanceFromBottom = scrollHeight - prevScrollTop - clientHeight;
    isUserScrolledUp = distanceFromBottom > 60;
    if (btnScrollToBottom) {
      btnScrollToBottom.style.display = isUserScrolledUp ? 'flex' : 'none';
    }
  });
}

if (btnScrollToBottom) {
  btnScrollToBottom.addEventListener('click', () => {
    isUserScrolledUp = false;
    forceScrollToBottom = true;
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
    btnScrollToBottom.style.display = 'none';
  });
}

function renderMessages() {
  if (!messagesContainer) return;

  if (messages.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (btnScrollToBottom) btnScrollToBottom.style.display = 'none';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  const prevScrollTop = messagesContainer.scrollTop;
  const prevScrollHeight = messagesContainer.scrollHeight;
  const clientHeight = messagesContainer.clientHeight;
  const distanceFromBottom = prevScrollHeight - prevScrollTop - clientHeight;
  const shouldAutoScroll = forceScrollToBottom || !isUserScrolledUp || distanceFromBottom <= 80 || prevScrollHeight <= clientHeight;

  messagesContainer.innerHTML = '';

  messages.forEach((msg) => {
    const itemEl = document.createElement('div');
    itemEl.className = `message-item ${msg.role}`;

    // 1. Unified Thinking & Tool Work Drawer (Auto-collapses when finished, matches IDE)
    const hasThinking = !!(msg.thinking && msg.thinking.trim().length > 15);
    const hasTools = !!(msg.toolCalls && msg.toolCalls.length > 0);
    if (msg.role === 'assistant' && (hasThinking || hasTools)) {
      const isLatestMessage = msg === messages[messages.length - 1];
      const isCurrentlyRunning = isAgentWorking && isLatestMessage;
      const isExplicitlyToggled = userExpandedWorkMap[msg.id] !== undefined;
      const isOpen = isExplicitlyToggled ? userExpandedWorkMap[msg.id] : isCurrentlyRunning;

      let workTitle = 'Worked for a few seconds';
      if (isCurrentlyRunning) {
        workTitle = hasTools ? 'Working...' : 'Thinking...';
      } else if (hasTools) {
        if (msg.toolCalls!.length >= 7) {
          workTitle = 'Worked for 1m';
        } else if (msg.toolCalls!.length >= 3) {
          workTitle = `Worked for ${msg.toolCalls!.length * 5}s`;
        } else {
          workTitle = 'Worked for a few seconds';
        }
      } else if (hasThinking) {
        workTitle = 'Thought for a few seconds';
      }

      const workEl = document.createElement('div');
      workEl.innerHTML = `
        <details class="ag-work-details" ${isOpen ? 'open' : ''} data-msg-id="${escapeHtml(msg.id)}">
          <summary class="ag-work-summary">
            <span class="ag-work-title">${escapeHtml(workTitle)}</span>
            <span class="ag-step-arrow">›</span>
          </summary>
          <div class="ag-work-body">
            ${hasThinking ? `<div class="ag-thinking-body">${renderThinkingMarkdown(msg.thinking!)}</div>` : ''}
            ${hasTools ? renderToolSteps(msg.toolCalls!) : ''}
          </div>
        </details>
      `;

      const details = workEl.querySelector('.ag-work-details') as HTMLDetailsElement | null;
      if (details) {
        details.addEventListener('toggle', () => {
          userExpandedWorkMap[msg.id] = details.open;
        });
      }

      itemEl.appendChild(workEl);
    }

    // 3. Formatted Markdown bubble
    if (msg.text && msg.text.trim()) {
      const bubbleEl = document.createElement('div');
      bubbleEl.className = 'message-bubble';
      bubbleEl.innerHTML = msg.role === 'user'
        ? escapeHtml(msg.text).replace(/\n/g, '<br/>')
        : getCachedMarkdown(msg.text);

      // Attached Element badge in User message
      if (msg.attachedElement) {
        const attachPreview = document.createElement('div');
        attachPreview.className = 'message-attach-preview';
        attachPreview.innerHTML = `
          <div style="font-size:10.5px;color:#38bdf8;font-weight:600;margin-top:6px;display:flex;align-items:center;gap:6px;">
            <span>📎 Target:</span> <code>${escapeHtml(msg.attachedElement.selector)}</code>
          </div>
        `;
        bubbleEl.appendChild(attachPreview);
      }

      // Attached Images preview in message
      if (msg.attachedImages && msg.attachedImages.length > 0) {
        const imgRow = document.createElement('div');
        imgRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
        msg.attachedImages.forEach((img) => {
          const imgEl = document.createElement('img');
          imgEl.src = img.dataUrl;
          imgEl.title = 'Click để phóng to ảnh xem chi tiết';
          imgEl.style.cssText = 'width:68px;height:68px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,0.2);cursor:zoom-in;transition:transform 0.12s ease;';
          imgEl.onmouseenter = () => { imgEl.style.transform = 'scale(1.05)'; };
          imgEl.onmouseleave = () => { imgEl.style.transform = 'scale(1)'; };
          imgEl.onclick = (e) => {
            e.stopPropagation();
            openImageLightbox(img.dataUrl);
          };
          imgRow.appendChild(imgEl);
        });
        bubbleEl.appendChild(imgRow);
      }

      itemEl.appendChild(bubbleEl);
    }

    // Message Action Toolbar (Hover bar: Timestamp, Copy, Undo)
    const actionsBar = document.createElement('div');
    actionsBar.className = 'msg-actions-bar';

    const dateObj = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    actionsBar.innerHTML = `
      <span class="msg-time">${timeStr}</span>
      <button type="button" class="msg-btn-action msg-btn-copy" title="Copy message text">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>
      </button>
      ${msg.role === 'user' ? `
        <button type="button" class="msg-btn-action msg-btn-undo" title="Sửa & Gửi lại (Undo)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>
        </button>
      ` : ''}
    `;

    const btnCopy = actionsBar.querySelector('.msg-btn-copy') as HTMLElement | null;
    if (btnCopy) {
      btnCopy.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(msg.text || '').then(() => {
          btnCopy.innerHTML = '✓';
          btnCopy.style.color = '#4ade80';
          setTimeout(() => {
            btnCopy.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>';
            btnCopy.style.color = '';
          }, 1200);
        });
      };
    }

    const btnUndo = actionsBar.querySelector('.msg-btn-undo') as HTMLElement | null;
    if (btnUndo) {
      btnUndo.onclick = (e) => {
        e.stopPropagation();
        promptInput.value = msg.text || '';
        promptInput.focus();
        promptInput.style.height = 'auto';
        promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
        if (msg.attachedElement) {
          attachElement(msg.attachedElement);
        }
        if (msg.attachedImages && msg.attachedImages.length > 0) {
          currentPastedImages = [...msg.attachedImages];
          renderPastedImages();
        }
        const msgIdx = messages.findIndex((m) => m.id === msg.id);
        if (msgIdx >= 0) {
          messages = messages.slice(0, msgIdx);
          forceScrollToBottom = true;
          isUserScrolledUp = false;
          renderMessages();
        }
      };
    }

    itemEl.appendChild(actionsBar);
    messagesContainer.appendChild(itemEl);
  });

  if (shouldAutoScroll) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    isUserScrolledUp = false;
    forceScrollToBottom = false;
    if (btnScrollToBottom) btnScrollToBottom.style.display = 'none';
  } else {
    // Keep user's exact scroll offset when reviewing history
    const newScrollHeight = messagesContainer.scrollHeight;
    const heightDelta = newScrollHeight - prevScrollHeight;
    messagesContainer.scrollTop = prevScrollTop + Math.max(0, heightDelta);
    if (btnScrollToBottom) btnScrollToBottom.style.display = 'flex';
  }
}

function openImageLightbox(src: string) {
  if (!src) return;
  let modal = document.getElementById('imageLightboxModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'imageLightboxModal';
    modal.className = 'image-lightbox-modal';
    modal.innerHTML = `
      <div class="lightbox-backdrop"></div>
      <div class="lightbox-container">
        <button type="button" class="lightbox-close" title="Đóng (Esc)">&times;</button>
        <img class="lightbox-img" src="" alt="Preview" />
      </div>
    `;
    document.body.appendChild(modal);

    const closeLightbox = () => {
      if (modal) modal.style.display = 'none';
    };

    modal.querySelector('.lightbox-backdrop')?.addEventListener('click', closeLightbox);
    modal.querySelector('.lightbox-close')?.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.style.display !== 'none') {
        closeLightbox();
      }
    });
  }

  const img = modal.querySelector('.lightbox-img') as HTMLImageElement | null;
  if (img) img.src = src;
  modal.style.display = 'flex';
}

function attachElement(el: AntiFanPickedElement) {
  currentAttachedElement = el;
  if (!attachedElementCard) return;
  attachedElementCard.style.display = 'flex';
  if (elementTag) {
    const classStr = Array.isArray(el.classes) && el.classes.length ? '.' + el.classes.slice(0, 2).join('.') : '';
    elementTag.textContent = `<${el.tag || el.selector || 'element'}${classStr}>`;
  }
  if (elementMeta) {
    const metaParts: string[] = [];
    if (el.rect && typeof el.rect.width === 'number') {
      metaParts.push(`${Math.round(el.rect.width)}×${Math.round(el.rect.height)}px`);
    }
    const font = el.fontFamily || el.computedStyles?.fontFamily;
    if (font) metaParts.push(font.split(',')[0]!.trim());
    const color = el.color || el.computedStyles?.color;
    if (color) metaParts.push(color);
    elementMeta.textContent = metaParts.join(' · ') || (el.selector || '');
  }

  if (elementThumb) {
    if (el.screenshotBase64) {
      elementThumb.style.backgroundImage = `url(data:image/png;base64,${el.screenshotBase64})`;
      elementThumb.style.display = 'block';
    } else {
      elementThumb.style.display = 'none';
    }
  }

  promptInput?.focus();
}

function clearAttachedElement() {
  currentAttachedElement = null;
  if (attachedElementCard) attachedElementCard.style.display = 'none';
}

if (btnRemoveElement) {
  btnRemoveElement.addEventListener('click', clearAttachedElement);
}

// Render Pasted Images Row
function renderPastedImages() {
  if (!pastedImagesRow) return;
  if (currentPastedImages.length === 0) {
    pastedImagesRow.style.display = 'none';
    pastedImagesRow.innerHTML = '';
    return;
  }
  pastedImagesRow.style.display = 'flex';
  pastedImagesRow.innerHTML = '';

  currentPastedImages.forEach((img, idx) => {
    const chip = document.createElement('div');
    chip.className = 'pasted-chip';
    chip.innerHTML = `
      <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}"/>
      <span>${escapeHtml(img.name)}</span>
      <button data-del="${idx}" title="Remove image">&times;</button>
    `;
    chip.querySelector('button')?.addEventListener('click', () => {
      currentPastedImages.splice(idx, 1);
      renderPastedImages();
    });
    pastedImagesRow.appendChild(chip);
  });
}

// Ctrl+V Paste handler on prompt input
promptInput.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            currentPastedImages.push({
              name: file.name || `image_${currentPastedImages.length + 1}.png`,
              dataUrl: reader.result,
            });
            renderPastedImages();
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }
});

// Autocomplete Catalog (Pre-populated defaults, dynamically enhanced with 100+ skills from host)
let AUTOCOMPLETE_ITEMS: Array<{ tag: string; desc: string; type?: string }> = [
  // Skills
  { tag: '/debug', desc: 'Systematic debugging and root-cause analysis', type: 'skill' },
  { tag: '/fix', desc: 'Fast bug, lint, and type error fixes', type: 'skill' },
  { tag: '/brainstorm', desc: 'CTO-level architecture and options exploration', type: 'skill' },
  { tag: '/research', desc: 'Deep technical research and best practices', type: 'skill' },
  { tag: '/fable-thinking', desc: 'Multi-hypothesis structured reasoning', type: 'skill' },
  { tag: '/cook', desc: 'Implement features with structured pipeline', type: 'skill' },
  { tag: '/test', desc: 'Run unit, integration, and UI tests', type: 'skill' },
  { tag: '/git', desc: 'Git conventional commit and branching', type: 'skill' },
  { tag: '/gsd-plan-phase', desc: 'Create milestone implementation plan', type: 'skill' },
  { tag: '/haravan-theme', desc: 'Haravan storefront and theme workflows', type: 'skill' },
  { tag: '/sapo', desc: 'Sapo/Bizweb Liquid & API workflows', type: 'skill' },
  { tag: '/shopify', desc: 'Shopify theme, app, and GraphQL API', type: 'skill' },
  // Agents & MCP
  { tag: '@docs', desc: 'Project documentation & architecture manager', type: 'agent' },
  { tag: '@code-reviewer', desc: 'Staff engineer production readiness review', type: 'agent' },
  { tag: '@brainstormer', desc: 'CTO-level system advisor & alternatives', type: 'agent' },
  { tag: '@code-simplifier', desc: 'Refactor and simplify code complexity', type: 'agent' },
  { tag: '@debugger', desc: 'Systematic root-cause diagnosis & hypothesis test', type: 'agent' },
  { tag: '@frontend-dev', desc: 'React, TypeScript, CSS & UI specialist', type: 'agent' },
  { tag: '@backend-dev', desc: 'Node.js, database, API & microservices', type: 'agent' },
  { tag: '@mcp-stitch', desc: 'Google Stitch AI UI design generation', type: 'mcp' },
  { tag: '@mcp-figma', desc: 'Figma Dev Mode design tokens inspection', type: 'mcp' },
];

let acActiveIndex = 0;
let acFiltered: typeof AUTOCOMPLETE_ITEMS = [];

function checkAutocomplete() {
  if (!autocompleteMenu) return;
  const val = promptInput.value;
  const cursor = promptInput.selectionStart || 0;
  const textBefore = val.slice(0, cursor);
  const match = textBefore.match(/(?:^|\s)([/@][a-zA-Z0-9_-]*)$/);

  if (!match) {
    autocompleteMenu.style.display = 'none';
    return;
  }

  const query = match[1]!.toLowerCase();
  acFiltered = AUTOCOMPLETE_ITEMS.filter((item) => item.tag.toLowerCase().startsWith(query));

  if (acFiltered.length === 0) {
    autocompleteMenu.style.display = 'none';
    return;
  }

  acActiveIndex = 0;
  renderAutocompleteMenu();
}

function renderAutocompleteMenu() {
  autocompleteMenu.innerHTML = '';
  acFiltered.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = `ac-item ${idx === acActiveIndex ? 'active' : ''}`;
    el.innerHTML = `
      <span class="ac-tag">${escapeHtml(item.tag)}</span>
      <span class="ac-desc">${escapeHtml(item.desc)}</span>
    `;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyAutocomplete(item.tag);
    });
    autocompleteMenu.appendChild(el);
  });
  autocompleteMenu.style.display = 'flex';
}

function applyAutocomplete(tag: string) {
  const val = promptInput.value;
  const cursor = promptInput.selectionStart || 0;
  const textBefore = val.slice(0, cursor);
  const textAfter = val.slice(cursor);
  const replacedBefore = textBefore.replace(/(?:^|\s)([/@][a-zA-Z0-9_-]*)$/, (m) => m.startsWith(' ') ? ' ' + tag + ' ' : tag + ' ');

  promptInput.value = replacedBefore + textAfter;
  promptInput.selectionStart = promptInput.selectionEnd = replacedBefore.length;
  autocompleteMenu.style.display = 'none';
  promptInput.focus();
}

function autoGrowPromptInput() {
  if (!promptInput) return;
  promptInput.style.height = 'auto';
  const maxHeight = 300; // max ~15 rows
  const newHeight = Math.min(Math.max(promptInput.scrollHeight, 38), maxHeight);
  promptInput.style.height = `${newHeight}px`;
  promptInput.style.overflowY = promptInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

// Input keydown for Autocomplete and Submit
promptInput.addEventListener('input', () => {
  autoGrowPromptInput();
  checkAutocomplete();
});
promptInput.addEventListener('keydown', (e) => {
  if (autocompleteMenu.style.display === 'flex' && acFiltered.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acActiveIndex = (acActiveIndex + 1) % acFiltered.length;
      renderAutocompleteMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      acActiveIndex = (acActiveIndex - 1 + acFiltered.length) % acFiltered.length;
      renderAutocompleteMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!e.shiftKey) {
        e.preventDefault();
        const selected = acFiltered[acActiveIndex];
        if (selected) applyAutocomplete(selected.tag);
        return;
      }
    }
    if (e.key === 'Escape') {
      autocompleteMenu.style.display = 'none';
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitCurrentComposer();
  }
});

function showSidebarToast(text: string, duration = 2000) {
  const toast = document.getElementById('sidebarToast');
  if (!toast) return;
  toast.textContent = text;
  toast.style.display = 'flex';
  toast.classList.remove('fade-out');
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => {
      toast.style.display = 'none';
      toast.classList.remove('fade-out');
    }, 200);
  }, duration);
}

const btnSend = document.getElementById('btnSend') as HTMLButtonElement | null;
if (btnSend) {
  btnSend.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isAgentWorking) {
      isAgentWorking = false;
      updateSendButtonState();
      updateSessionDropdown();
      const targetSession = activeSessionId === 'auto' ? undefined : activeSessionId;
      getApi()?.abortGeneration(targetSession);
      showSidebarToast('⏸ Đã tạm dừng phản hồi', 2000);
      promptInput?.focus();
      return;
    }
    submitCurrentComposer();
  });
}

function updateSendButtonState() {
  if (!btnSend) return;
  if (isAgentWorking) {
    btnSend.classList.add('working');
    btnSend.title = 'Tạm dừng / Dừng phản hồi (Pause)';
    btnSend.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>`;
  } else {
    btnSend.classList.remove('working');
    btnSend.title = 'Gửi tin nhắn (Enter)';
    btnSend.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M15.854.146a.5.5 0 0 1 .11.54l-5.8 14.5a.5.5 0 0 1-.928.008L6.47 9.53 1.806 6.764a.5.5 0 0 1 .008-.928l14.5-5.8a.5.5 0 0 1 .54.11zM6.85 8.94l2.67 4.005L14.07 2.22 6.85 8.94zm-.81-.81L13.78 1.93 1.055 6.48l4.005 2.67.98-.98z"/></svg>`;
  }
}

async function submitCurrentComposer() {
  const text = promptInput.value.trim();
  if (!text && !currentAttachedElement && currentPastedImages.length === 0) {
    return;
  }

  const userMsg: ChatMessage = {
    id: String(Date.now()),
    role: 'user',
    text: text || 'Analyze attached evidence:',
    attachedElement: currentAttachedElement || undefined,
    attachedImages: currentPastedImages.length > 0 ? [...currentPastedImages] : undefined,
    timestamp: Date.now(),
  };

  promptInput.value = '';
  promptInput.style.height = 'auto';
  promptInput.style.overflowY = 'hidden';
  const sentAttached = currentAttachedElement;
  const sentImages = [...currentPastedImages];
  clearAttachedElement();
  currentPastedImages = [];
  renderPastedImages();
  if (autocompleteMenu) autocompleteMenu.style.display = 'none';

  const deliveryMode = deliveryModeSelect?.value || 'sequential';
  const targetSession = activeSessionId === 'auto' ? undefined : activeSessionId;

  if (deliveryMode === 'draft') {
    await getApi()?.sendPrompt(userMsg.text, sentAttached, sentImages, 'draft', targetSession);
    return;
  }

  const currentSession = cachedSessions.find((s) => s.id === (activeSessionId === 'auto' ? undefined : activeSessionId));
  const isRunning = (currentSession && currentSession.status === 'running') || isAgentWorking;

  if (deliveryMode === 'sequential' && isRunning) {
    // Add immediately to sequential queue on first Enter
    messageQueue.push({
      id: userMsg.id,
      text: userMsg.text,
      attachedElement: sentAttached,
      attachedImages: sentImages,
      targetSession,
      deliveryMode,
      timestamp: Date.now(),
    });
    renderQueueCard();
    return;
  }

  isAgentWorking = true;
  updateSendButtonState();
  messages.push(userMsg);
  renderMessages();
  await getApi()?.sendPrompt(userMsg.text, sentAttached, sentImages, 'auto', targetSession);
}

// Quick prompts
document.querySelectorAll('.prompt-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-prompt');
    if (prompt) {
      promptInput.value = prompt;
      promptInput.focus();
    }
  });
});

// Refresh button for Undo / Checkpoint session sync
const btnRefreshSession = document.getElementById('btnRefreshSession') as HTMLButtonElement | null;
if (btnRefreshSession) {
  btnRefreshSession.addEventListener('click', async () => {
    isAgentWorking = false;
    updateSendButtonState();
    const api = getApi();
    if (api) {
      try {
        const res = await api.getInitialState();
        if (res && res.messages) {
          messages = res.messages;
          scheduleRender();
        }
        await updateSessionDropdown();
      } catch {}
    }
  });
}

// Clear button
if (btnClear) {
  btnClear.addEventListener('click', async () => {
    messages = [];
    renderMessages();
    await getApi()?.clearHistory();
  });
}

// Close button
if (btnClose) {
  btnClose.addEventListener('click', async () => {
    await getApi()?.closeSidebar();
  });
}

// Ultra-smooth Resizer logic with full overlay and requestAnimationFrame IPC
function setupResizer() {
  const resizer = document.getElementById('sidebarResizer') || sidebarResizer;
  if (!resizer || !sidebarRoot) return;

  const savedWidthStr = localStorage.getItem('antifan_sidebar_width');
  let initialWidth = 380;
  if (savedWidthStr) {
    const parsed = parseInt(savedWidthStr, 10);
    if (!isNaN(parsed) && parsed >= 260 && parsed <= 850) {
      initialWidth = parsed;
      sidebarRoot.style.width = `${initialWidth}px`;
      getApi()?.setWidth(initialWidth);
    }
  }

  let isDragging = false;
  let startX = 0;
  let startWidth = initialWidth;
  let lastTargetWidth = initialWidth;
  let resizeRaf: number | null = null;
  let dragOverlay: HTMLElement | null = null;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = sidebarRoot.getBoundingClientRect().width;
    lastTargetWidth = startWidth;
    resizer.classList.add('dragging');
    e.preventDefault();

    dragOverlay = document.createElement('div');
    dragOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;cursor:ew-resize !important;user-select:none;';
    document.body.appendChild(dragOverlay);

    document.addEventListener('mousemove', onMouseMove, { capture: true });
    document.addEventListener('mouseup', onMouseUp, { capture: true });
  });

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const deltaX = startX - e.clientX;
    lastTargetWidth = Math.max(260, Math.min(850, startWidth + deltaX));

    // 1. Instant local DOM visual feedback (Zero lag)
    sidebarRoot.style.width = `${lastTargetWidth}px`;

    // 2. Throttled IPC update (at display refresh rate)
    if (resizeRaf === null) {
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        getApi()?.setWidth(lastTargetWidth);
      });
    }
  };

  const onMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('dragging');
      if (dragOverlay) {
        dragOverlay.remove();
        dragOverlay = null;
      }
      document.removeEventListener('mousemove', onMouseMove, { capture: true });
      document.removeEventListener('mouseup', onMouseUp, { capture: true });
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = null;
      }
      localStorage.setItem('antifan_sidebar_width', String(lastTargetWidth));
      getApi()?.setWidth(lastTargetWidth);
    }
  };
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderMessages();
  });
}

let cachedSessions: any[] = [];
let activeSessionId = localStorage.getItem('antifan_active_session_id') || 'auto';
let selectedGroup = 'all';
let targetSessionForAction: string | null = null;

let sessionSeenCounts: Record<string, number> = {};
try {
  const saved = localStorage.getItem('antifan_session_seen_counts');
  if (saved) sessionSeenCounts = JSON.parse(saved);
} catch {}

function markSessionAsSeen(sessionId: string, count: number) {
  if (!sessionId) return;
  sessionSeenCounts[sessionId] = count;
  try {
    localStorage.setItem('antifan_session_seen_counts', JSON.stringify(sessionSeenCounts));
  } catch {}
}

function renderQuickSessionsBar() {
  const bar = document.getElementById('quickSessionsBar');
  if (!bar) return;
  bar.innerHTML = '';

  // 1. Auto-Follow Chip (Always first)
  const autoChip = document.createElement('div');
  const isAutoActive = activeSessionId === 'auto';
  autoChip.className = `quick-session-chip ${isAutoActive ? 'active' : ''}`;
  autoChip.title = '⚡ Tự động bám sát phiên IDE đang hoạt động';
  autoChip.innerHTML = `
    <span class="quick-chip-icon" style="color:#38bdf8;">⚡</span>
    <span class="quick-chip-title">Auto</span>
  `;
  autoChip.onclick = async () => {
    activeSessionId = 'auto';
    localStorage.setItem('antifan_active_session_id', 'auto');
    pillTitle.textContent = 'Auto-follow (Active IDE)';
    renderQuickSessionsBar();
    renderSessionDropdownMenu();
    renderQueueCard();
    processQueueIfIdle();
    try {
      const res = await getApi()?.switchSession('auto');
      if (res && res.messages) {
        messages = res.messages;
        forceScrollToBottom = true;
        isUserScrolledUp = false;
        scheduleRender();
      }
    } catch {}
  };
  bar.appendChild(autoChip);

  // 2. Top 4-5 Recent/Active Sessions
  const topSessions = cachedSessions.slice(0, 5);
  topSessions.forEach((s) => {
    const isCurrent = s.id === activeSessionId || (activeSessionId === 'auto' && s.active);
    const isRunning = s.status === 'running';
    const lastSeen = sessionSeenCounts[s.id] || 0;
    const msgCount = s.messageCount || 0;
    const hasUnread = !isCurrent && msgCount > lastSeen;
    const unreadCount = Math.max(0, msgCount - lastSeen);

    const chip = document.createElement('div');
    chip.className = `quick-session-chip ${isCurrent ? 'active' : ''} ${isRunning ? 'is-running' : ''} ${hasUnread ? 'has-unread' : ''}`;
    chip.title = `${s.title || s.id}\n${isRunning ? '⏳ Đang xử lý...' : hasUnread ? `🔵 ${unreadCount} tin nhắn mới chưa đọc` : '💬 Đã xem'}`;

    let cleanTitle = s.title || s.id;
    if (cleanTitle.length > 18) {
      cleanTitle = cleanTitle.slice(0, 16) + '…';
    }

    let statusHtml = '';
    if (isRunning) {
      statusHtml = `<span class="quick-chip-spinner" title="Đang xử lý..."></span>`;
    } else if (hasUnread) {
      statusHtml = `<span class="quick-chip-unread-dot" title="${unreadCount} tin mới"></span>`;
    } else {
      statusHtml = `<span class="quick-chip-icon">💬</span>`;
    }

    const unreadBadgeHtml = hasUnread && unreadCount > 1
      ? `<span class="quick-unread-count">+${unreadCount}</span>`
      : '';

    chip.innerHTML = `
      ${statusHtml}
      <span class="quick-chip-title">${escapeHtml(cleanTitle)}</span>
      ${unreadBadgeHtml}
    `;

    chip.onclick = async () => {
      activeSessionId = s.id;
      localStorage.setItem('antifan_active_session_id', s.id);
      markSessionAsSeen(s.id, s.messageCount || 0);
      pillTitle.textContent = s.title || s.id;
      pillStatusDot.className = `session-status-dot ${isRunning ? 'running' : 'done'}`;
      renderQuickSessionsBar();
      renderSessionDropdownMenu();
      renderQueueCard();
      processQueueIfIdle();
      try {
        const res = await getApi()?.switchSession(s.id);
        if (res && res.messages) {
          messages = res.messages;
          forceScrollToBottom = true;
          isUserScrolledUp = false;
          scheduleRender();
        }
      } catch {}
    };

    bar.appendChild(chip);
  });
}

function renderSessionDropdownMenu() {
  if (!sessionListItems) return;
  sessionListItems.innerHTML = '';

  const query = (sessionSearchInput?.value || '').toLowerCase().trim();

  // 1. Render Auto-follow item
  if (!query || 'auto-follow active ide'.includes(query)) {
    const autoItem = document.createElement('div');
    autoItem.className = `session-item ${activeSessionId === 'auto' ? 'active' : ''}`;
    autoItem.innerHTML = `
      <span class="session-item-status">⚡</span>
      <div class="session-item-content">
        <span class="session-item-title">Auto-follow (Active IDE)</span>
        <span class="session-item-meta">Tự động bám sát session đang active trong Antigravity IDE</span>
      </div>
    `;
    autoItem.onclick = async () => {
      activeSessionId = 'auto';
      pillTitle.textContent = 'Auto-follow (Active IDE)';
      pillStatusDot.className = 'session-status-dot done';
      renderQuickSessionsBar();
      sessionMenuDropdown.style.display = 'none';
      try {
        const res = await getApi()?.switchSession('auto');
        if (res && res.messages) {
          messages = res.messages;
          forceScrollToBottom = true;
          isUserScrolledUp = false;
          scheduleRender();
        }
      } catch {}
    };
    sessionListItems.appendChild(autoItem);
  }

  // 2. Extract unique project groups for filter chips
  const groups = new Set<string>();
  cachedSessions.forEach((s) => {
    if (s.projectGroup) groups.add(s.projectGroup);
  });

  if (sessionFilterChips) {
    sessionFilterChips.innerHTML = `<span class="filter-chip ${selectedGroup === 'all' ? 'active' : ''}" data-group="all">Tất cả (${cachedSessions.length})</span>`;
    groups.forEach((g) => {
      const chip = document.createElement('span');
      chip.className = `filter-chip ${selectedGroup === g ? 'active' : ''}`;
      chip.dataset.group = g;
      chip.textContent = g;
      chip.onclick = (e) => {
        e.stopPropagation();
        selectedGroup = g;
        renderSessionDropdownMenu();
      };
      sessionFilterChips.appendChild(chip);
    });
    const allChip = sessionFilterChips.querySelector('[data-group="all"]') as HTMLElement | null;
    if (allChip) {
      allChip.onclick = (e) => {
        e.stopPropagation();
        selectedGroup = 'all';
        renderSessionDropdownMenu();
      };
    }
  }

  // 3. Filter sessions
  const filtered = cachedSessions.filter((s) => {
    if (selectedGroup !== 'all' && s.projectGroup !== selectedGroup) return false;
    if (query) {
      const matchTitle = (s.title || '').toLowerCase().includes(query);
      const matchGroup = (s.projectGroup || '').toLowerCase().includes(query);
      return matchTitle || matchGroup;
    }
    return true;
  });

  // 4. Render session items
  filtered.forEach((s) => {
    const item = document.createElement('div');
    const isCurrent = s.id === activeSessionId || (activeSessionId === 'auto' && s.active);
    const lastSeen = sessionSeenCounts[s.id] || 0;
    const msgCount = s.messageCount || 0;
    const hasUnread = !isCurrent && msgCount > lastSeen;

    item.className = `session-item ${isCurrent ? 'active' : ''}`;

    const isRunning = s.status === 'running';
    const statusIcon = isRunning ? '⏳' : hasUnread ? '🔵' : '💬';
    const statusTitle = isRunning ? 'Đang xử lý' : hasUnread ? 'Có tin mới chưa đọc' : 'Đã xem';

    item.innerHTML = `
      <span class="session-item-status" title="${statusTitle}">${statusIcon}</span>
      <div class="session-item-content">
        <span class="session-item-title">${escapeHtml(s.title || s.id)}</span>
        <span class="session-item-meta">${escapeHtml(s.projectGroup || 'General')} · ${s.messageCount || 0} tin nhắn</span>
      </div>
      <div class="session-item-actions">
        <button class="session-action-btn rename-btn" title="Đổi tên">✏️</button>
        <button class="session-action-btn delete delete-btn" title="Xóa">🗑️</button>
      </div>
    `;

    item.onclick = async (e) => {
      if ((e.target as HTMLElement).closest('.session-action-btn')) return;
      activeSessionId = s.id;
      markSessionAsSeen(s.id, s.messageCount || 0);
      pillTitle.textContent = s.title || s.id;
      pillStatusDot.className = `session-status-dot ${isRunning ? 'running' : 'done'}`;
      renderQuickSessionsBar();
      sessionMenuDropdown.style.display = 'none';
      renderQueueCard();
      processQueueIfIdle();
      try {
        const res = await getApi()?.switchSession(s.id);
        if (res && res.messages) {
          messages = res.messages;
          forceScrollToBottom = true;
          isUserScrolledUp = false;
          scheduleRender();
        }
      } catch {}
    };

    const btnRen = item.querySelector('.rename-btn') as HTMLElement | null;
    if (btnRen) {
      btnRen.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        targetSessionForAction = s.id;
        if (renameInput) renameInput.value = s.title || '';
        if (renameModal) renameModal.style.display = 'block';
        if (deleteModal) deleteModal.style.display = 'none';
        sessionMenuDropdown.style.display = 'none';
        setTimeout(() => renameInput?.focus(), 50);
      };
    }

    const btnDel = item.querySelector('.delete-btn') as HTMLElement | null;
    if (btnDel) {
      btnDel.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        targetSessionForAction = s.id;
        if (deleteModal) deleteModal.style.display = 'block';
        if (renameModal) renameModal.style.display = 'none';
        sessionMenuDropdown.style.display = 'none';
      };
    }

    sessionListItems.appendChild(item);
  });
}

async function updateSessionDropdown() {
  try {
    const data = await getApi()?.getSessions();
    if (data && Array.isArray(data.sessions)) {
      cachedSessions = data.sessions;
      const activeObj = cachedSessions.find((s) => s.active);
      if (activeSessionId === 'auto') {
        pillTitle.textContent = activeObj ? activeObj.title : 'Auto-follow (Active IDE)';
        pillStatusDot.className = `session-status-dot ${activeObj?.status === 'running' ? 'running' : 'done'}`;
        if (activeObj) {
          markSessionAsSeen(activeObj.id, activeObj.messageCount || messages.length);
        }
      } else {
        const sel = cachedSessions.find((s) => s.id === activeSessionId);
        if (sel) {
          pillTitle.textContent = sel.title;
          pillStatusDot.className = `session-status-dot ${sel.status === 'running' ? 'running' : 'done'}`;
          markSessionAsSeen(sel.id, sel.messageCount || messages.length);
        }
      }
      renderSessionDropdownMenu();
      renderQuickSessionsBar();
    }
  } catch {}
}

if (btnSessionPill) {
  btnSessionPill.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = sessionMenuDropdown.style.display === 'none';
    sessionMenuDropdown.style.display = isHidden ? 'flex' : 'none';
    if (isHidden) {
      updateSessionDropdown();
      setTimeout(() => sessionSearchInput?.focus(), 50);
    }
  });
}

if (sessionSearchInput) {
  sessionSearchInput.addEventListener('input', () => {
    renderSessionDropdownMenu();
  });
}

document.addEventListener('click', (e) => {
  if (sessionMenuDropdown && sessionMenuDropdown.style.display !== 'none') {
    if (!sessionMenuDropdown.contains(e.target as Node) && !btnSessionPill.contains(e.target as Node)) {
      sessionMenuDropdown.style.display = 'none';
    }
  }
});

// Inline Rename Modal Handler
async function saveRename() {
  const newName = renameInput.value.trim();
  if (!newName || !targetSessionForAction) return;
  if (renameModal) renameModal.style.display = 'none';
  const res = await getApi()?.renameSession(targetSessionForAction, newName);
  targetSessionForAction = null;
  if (res && res.sessions) {
    await updateSessionDropdown();
  }
}

if (btnSaveRename) btnSaveRename.addEventListener('click', saveRename);
if (btnCancelRename) btnCancelRename.addEventListener('click', () => {
  if (renameModal) renameModal.style.display = 'none';
  targetSessionForAction = null;
});
if (renameInput) {
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (renameModal) renameModal.style.display = 'none';
      targetSessionForAction = null;
    }
  });
}

// Inline Delete Modal Handler
if (btnConfirmDelete) {
  btnConfirmDelete.addEventListener('click', async () => {
    if (deleteModal) deleteModal.style.display = 'none';
    if (!targetSessionForAction) return;
    const res = await getApi()?.deleteSession(targetSessionForAction);
    targetSessionForAction = null;
    if (res) {
      if (res.messages) messages = res.messages;
      scheduleRender();
      await updateSessionDropdown();
    }
  });
}

if (btnCancelDelete) {
  btnCancelDelete.addEventListener('click', () => {
    if (deleteModal) deleteModal.style.display = 'none';
    targetSessionForAction = null;
  });
}

async function initSidebar() {
  setupResizer();
  renderQueueCard();
  await updateSessionDropdown();

  const api = getApi();
  if (!api) return;

  try {
    const state = await api.getInitialState();
    if (state && state.messages) {
      messages = state.messages;
      scheduleRender();
    }
    if (state && Array.isArray(state.autocompleteItems) && state.autocompleteItems.length > 0) {
      AUTOCOMPLETE_ITEMS = state.autocompleteItems;
    }
  } catch {}

  // Fetch full dynamic skills catalog if needed
  if (AUTOCOMPLETE_ITEMS.length <= 25) {
    try {
      const dynamicItems = await api.getAutocompleteItems();
      if (Array.isArray(dynamicItems) && dynamicItems.length > 0) {
        AUTOCOMPLETE_ITEMS = dynamicItems;
      }
    } catch {}
  }

  api.onStreamUpdate((data: any) => {
    if (data && data.message) {
      const incoming = data.message;
      const msgSessionId = incoming.sessionId || data.sessionId;

      // If user selected a specific session and this stream update is for another session, DO NOT hijack current messages view!
      if (activeSessionId !== 'auto' && msgSessionId && msgSessionId !== activeSessionId) {
        updateSessionDropdown();
        return;
      }

      // Deduplicate user messages: If incoming is user message, match against existing recent user messages
      if (incoming.role === 'user') {
        const cleanIncoming = (incoming.text || '').replace(/@\[.*?\]/g, '').trim();
        const dupIdx = messages.findIndex((m) => {
          if (m.role !== 'user') return false;
          if (m.id === incoming.id) return true;
          const cleanExisting = (m.text || '').replace(/@\[.*?\]/g, '').trim();
          if (cleanIncoming === cleanExisting) return true;
          if (cleanIncoming.length > 3 && cleanExisting.length > 3) {
            return cleanIncoming.startsWith(cleanExisting) || cleanExisting.startsWith(cleanIncoming);
          }
          return false;
        });
        if (dupIdx >= 0) {
          const existing = messages[dupIdx];
          if (existing) {
            messages[dupIdx] = {
              ...incoming,
              attachedElement: incoming.attachedElement || existing.attachedElement,
              attachedImages: (incoming.attachedImages && incoming.attachedImages.length > 0)
                ? incoming.attachedImages
                : existing.attachedImages,
            };
          }
          scheduleRender();
          return;
        }
      }

      // Check agent working state
      if (incoming.role === 'assistant' || incoming.role === 'system') {
        const hasText = !!(incoming.text && incoming.text.trim().length > 0);
        const hasTools = !!(incoming.toolCalls && incoming.toolCalls.length > 0);
        const hasToolInProgress = !!(incoming.toolCalls && incoming.toolCalls.some((t: any) => t.status === 'running'));
        
        if (hasTools || hasToolInProgress) {
          isAgentWorking = true;
        } else if (hasText) {
          isAgentWorking = false;
        }
        updateSendButtonState();
        updateSessionDropdown();
        if (!isAgentWorking) {
          setTimeout(() => processQueueIfIdle(), 400);
        }

        // Merge consecutive assistant stream events belonging to this turn into ONE message
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.id !== incoming.id) {
          if (incoming.text) lastMsg.text = incoming.text;
          if (incoming.thinking) lastMsg.thinking = incoming.thinking;
          if (incoming.toolCalls && incoming.toolCalls.length > 0) {
            const existingKeys = new Set((lastMsg.toolCalls || []).map((t) => `${t.name}-${JSON.stringify(t.args || {})}`));
            const newTools = incoming.toolCalls.filter((t: any) => !existingKeys.has(`${t.name}-${JSON.stringify(t.args || {})}`));
            lastMsg.toolCalls = [...(lastMsg.toolCalls || []), ...newTools];
          }
          scheduleRender();
          return;
        }
      }

      const idx = messages.findIndex((m) => m.id === incoming.id);
      if (idx >= 0) {
        messages[idx] = incoming;
      } else {
        messages.push(incoming);
      }
      scheduleRender();
    }
  });

  api.onSessionChanged((data: any) => {
    // If user is locked to a specific session, do not auto-jump when background session changes
    if (activeSessionId !== 'auto' && data && data.sessionId && data.sessionId !== activeSessionId) {
      updateSessionDropdown();
      return;
    }
    if (data && data.messages) {
      messages = data.messages;
      const wasWorking = isAgentWorking;
      if (typeof data.isRunning === 'boolean') {
        isAgentWorking = data.isRunning;
      }
      updateSendButtonState();
      scheduleRender();

      // If agent is now idle and queue has items, dispatch immediately!
      if (!isAgentWorking && messageQueue.length > 0) {
        setTimeout(() => processQueueIfIdle(), 300);
      }
    }
    updateSessionDropdown();
  });

  // Watchdog: Check if queue has pending items when agent is idle
  setInterval(() => {
    if (!isAgentWorking && messageQueue.length > 0 && !isProcessingQueue) {
      processQueueIfIdle();
    }
  }, 1200);

  api.onAttachElement((element: AntiFanPickedElement) => {
    if (element) {
      attachElement(element);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebar);
} else {
  initSidebar();
}

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
  sendPrompt: (text: string, attachedElement?: any, attachedImages?: any, deliveryMode?: 'auto' | 'draft') => Promise<any>;
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

interface QueuedItem {
  id: string;
  text: string;
  attachedElement?: AntiFanPickedElement | null;
  attachedImages?: Array<{ name: string; dataUrl: string }>;
  deliveryMode?: string;
  timestamp: number;
}

let messageQueue: QueuedItem[] = [];
const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const promptInput = document.getElementById('promptInput') as HTMLTextAreaElement;
const btnClear = document.getElementById('btnClear')!;
const btnClose = document.getElementById('btnClose')!;

if (deliveryModeSelect) {
  const savedMode = localStorage.getItem('antifan_delivery_mode') || 'auto';
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

/**
 * Rich Markdown Parser with 100% Antigravity Code Block styling
 */
function renderMarkdown(md: string): string {
  if (!md) return '';

  let html = md;

  // 1. Code blocks with language badge and copy icon
  const codeBlocks: string[] = [];
  html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_match, lang, code) => {
    const placeholder = `___CODEBLOCK_${codeBlocks.length}___`;
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

  // 2b. Markdown Tables (extracted with placeholders like code blocks)
  const tableBlocks: string[] = [];
  html = parseMarkdownTables(html, tableBlocks);

  // 3. Inline code & inline styles
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="md-link">$1</a>');

  // 4. Line-by-line block processing
  const lines = html.split('\n');
  const processed: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Check list item
    const listMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        processed.push('<ul class="md-list">');
        inList = true;
      }
      processed.push(`<li>${listMatch[1]}</li>`);
      continue;
    } else if (inList) {
      processed.push('</ul>');
      inList = false;
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
    } else if (trimmed.startsWith('___CODEBLOCK_') || trimmed.startsWith('___TABLE_')) {
      processed.push(line);
    } else {
      processed.push(`<p>${line}</p>`);
    }
  }

  if (inList) {
    processed.push('</ul>');
  }

  let finalHtml = processed.join('\n');

  // 5. Restore code blocks and table blocks
  codeBlocks.forEach((block, idx) => {
    finalHtml = finalHtml.replace(`___CODEBLOCK_${idx}___`, block);
  });
  tableBlocks.forEach((block, idx) => {
    finalHtml = finalHtml.replace(`___TABLE_${idx}___`, block);
  });

  return finalHtml;
}

function parseMarkdownTables(text: string, tableBlocks: string[]): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];

  const isTableLine = (l: string) => {
    const trimmed = l.trim();
    return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
  };
  const isSeparatorLine = (l: string) => /^\|(\s*:?-+:?\s*\|)+$/.test(l.trim());

  const flushTable = () => {
    if (tableHeaders.length === 0 && tableRows.length === 0) return;
    const thead = '<thead><tr>' + tableHeaders.map((h) => `<th>${h}</th>`).join('') + '</tr></thead>';
    const tbody = '<tbody>' + tableRows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
    const tableHtml = `<div class="md-table-wrapper"><table class="md-table">${thead}${tbody}</table></div>`;
    const placeholder = `___TABLE_${tableBlocks.length}___`;
    tableBlocks.push(tableHtml);
    result.push(placeholder);
    tableHeaders = [];
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isTableLine(line)) {
      if (!inTable && i + 1 < lines.length && isSeparatorLine(lines[i + 1]!)) {
        // Table start detected
        inTable = true;
        tableHeaders = line.split('|').map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        i++; // Skip separator line
        tableRows = [];
        continue;
      } else if (inTable) {
        const rowCells = line.split('|').map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        tableRows.push(rowCells);
        continue;
      }
    }

    if (inTable) {
      inTable = false;
      flushTable();
    }
    result.push(line);
  }

  if (inTable) {
    flushTable();
  }

  return result.join('\n');
}

/**
 * Renders Antigravity Tool Calls matching IDE Screenshot Single-Line Style
 */
function renderToolSteps(tools: ChatToolCall[]): string {
  if (!tools || tools.length === 0) return '';

  let html = '';
  tools.forEach((tool) => {
    const args = tool.args || {};
    let title = tool.name;
    let detailContent = '';

    if (tool.name === 'run_command') {
      const rawCmd = args.CommandLine || '';
      const briefCmd = rawCmd.length > 38 ? rawCmd.slice(0, 38) + '...' : rawCmd;
      title = `Ran ${briefCmd || 'command'}`;
      detailContent = `
        <div class="ag-code-box">
          <span class="ag-code-path">...\\workspace &gt;</span>
          <span class="ag-code-cmd">${escapeHtml(rawCmd)}</span>
        </div>
      `;
    } else if (tool.name === 'view_file' || tool.name === 'read_file') {
      const fileName = args.AbsolutePath ? args.AbsolutePath.split(/[\\/]/).pop() : (args.path || 'file');
      const lines = args.StartLine ? ` #L${args.StartLine}-${args.EndLine || ''}` : '';
      title = `Analyzed ${fileName}${lines}`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(args.AbsolutePath || args.path || '')}</div>`;
    } else if (tool.name === 'write_to_file' || tool.name === 'replace_file_content' || tool.name === 'multi_replace_file_content') {
      const fileName = args.TargetFile ? args.TargetFile.split(/[\\/]/).pop() : (args.path || 'file');
      title = `Edited ${fileName}`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">Modified ${escapeHtml(args.TargetFile || args.path || '')}</div>`;
    } else if (tool.name === 'grep_search') {
      title = `Explored 1 file, 1 search`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">Query: ${escapeHtml(args.Query || '')}</div>`;
    } else if (tool.name === 'list_dir') {
      title = `Explored directory`;
      detailContent = `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(args.DirectoryPath || '')}</div>`;
    }

    html += `
      <details class="ag-step-details">
        <summary class="ag-step-summary">
          <span class="ag-step-title">${escapeHtml(title)}</span>
          <span class="ag-step-arrow">›</span>
        </summary>
        ${detailContent ? `<div class="ag-step-content">${detailContent}</div>` : ''}
      </details>
    `;
  });

  return html;
}

function renderMessages() {
  if (!messagesContainer) return;

  if (messages.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  // Smart auto-scroll: only force scroll to bottom if user is currently near bottom
  const wasNearBottom = (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) <= 80;

  messagesContainer.innerHTML = '';

  messages.forEach((msg) => {
    const itemEl = document.createElement('div');
    itemEl.className = `message-item ${msg.role}`;

    // 1. Thinking drawer (Only if meaningful thought exists)
    if (msg.thinking && msg.thinking.trim().length > 15) {
      const thinkingEl = document.createElement('div');
      thinkingEl.innerHTML = `
        <details class="ag-thinking-details">
          <summary class="ag-thinking-summary">
            <span>Thought for a few seconds</span>
            <span class="ag-step-arrow">›</span>
          </summary>
          <div class="ag-thinking-body">${escapeHtml(msg.thinking.trim())}</div>
        </details>
      `;
      itemEl.appendChild(thinkingEl);
    }

    // 2. Tool calls step lines
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolCards = document.createElement('div');
      toolCards.innerHTML = renderToolSteps(msg.toolCalls);
      itemEl.appendChild(toolCards);
    }

    // 3. Formatted Markdown bubble
    if (msg.text && msg.text.trim()) {
      const bubbleEl = document.createElement('div');
      bubbleEl.className = 'message-bubble';
      bubbleEl.innerHTML = msg.role === 'user' ? escapeHtml(msg.text) : renderMarkdown(msg.text);

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
          imgEl.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid #3f3f46;';
          imgRow.appendChild(imgEl);
        });
        bubbleEl.appendChild(imgRow);
      }

      itemEl.appendChild(bubbleEl);
    }
    messagesContainer.appendChild(itemEl);
  });

  if (wasNearBottom) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function attachElement(el: AntiFanPickedElement) {
  currentAttachedElement = el;
  attachedElementCard.style.display = 'flex';
  elementTag.textContent = `<${el.tag}${el.classes.length ? '.' + el.classes.slice(0, 2).join('.') : ''}>`;
  elementMeta.textContent = `${el.rect.width}×${el.rect.height}px · ${el.fontFamily || 'sans-serif'}`;

  if (el.screenshotBase64) {
    elementThumb.style.backgroundImage = `url(data:image/png;base64,${el.screenshotBase64})`;
    elementThumb.style.display = 'block';
  } else {
    elementThumb.style.display = 'none';
  }

  promptInput.focus();
}

function clearAttachedElement() {
  currentAttachedElement = null;
  attachedElementCard.style.display = 'none';
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

// Autocomplete Catalog
const AUTOCOMPLETE_ITEMS = [
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
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});

function renderMessageQueue() {
  if (!messageQueueCard || !queueCount || !queueList) return;
  if (messageQueue.length === 0) {
    messageQueueCard.style.display = 'none';
    return;
  }
  messageQueueCard.style.display = 'block';
  queueCount.textContent = String(messageQueue.length);
  queueList.innerHTML = '';

  messageQueue.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `
      <span style="font-weight:600;color:#38bdf8;font-size:10px;">#${idx + 1}</span>
      <span class="queue-item-text">${escapeHtml(item.text || 'Attached evidence')}</span>
      <button class="queue-item-del" data-id="${item.id}" title="Xóa khỏi hàng đợi">&times;</button>
    `;
    const btnDel = row.querySelector('.queue-item-del') as HTMLElement | null;
    if (btnDel) {
      btnDel.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        messageQueue = messageQueue.filter((q) => q.id !== item.id);
        renderMessageQueue();
      };
    }
    queueList.appendChild(row);
  });
}

function processMessageQueueIfIdle() {
  const currentActive = cachedSessions.find((s) => s.id === activeSessionId || (activeSessionId === 'auto' && s.active));
  const isRunning = currentActive && currentActive.status === 'running';

  if (!isRunning && messageQueue.length > 0) {
    const next = messageQueue.shift();
    renderMessageQueue();
    if (next) {
      const userMsg: ChatMessage = {
        id: String(Date.now()),
        role: 'user',
        text: next.text || 'Analyze attached evidence:',
        attachedElement: next.attachedElement || undefined,
        attachedImages: next.attachedImages && next.attachedImages.length > 0 ? next.attachedImages : undefined,
        timestamp: Date.now(),
      };
      messages.push(userMsg);
      renderMessages();
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      getApi()?.sendPrompt(userMsg.text, next.attachedElement || undefined, next.attachedImages, (next.deliveryMode || 'auto') as any);
    }
  }
}

if (btnClearQueue) {
  btnClearQueue.addEventListener('click', () => {
    messageQueue = [];
    renderMessageQueue();
  });
}

// Form submit
if (chatForm) {
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = promptInput.value.trim();
    if (!text && !currentAttachedElement && currentPastedImages.length === 0) return;

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

    const deliveryMode = (deliveryModeSelect ? deliveryModeSelect.value : 'auto');

    if (deliveryMode === 'queue') {
      messageQueue.push({
        id: String(Date.now()),
        text: userMsg.text,
        attachedElement: sentAttached,
        attachedImages: sentImages,
        deliveryMode: 'auto',
        timestamp: Date.now(),
      });
      renderMessageQueue();
      return;
    }

    messages.push(userMsg);
    renderMessages();
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    try {
      getApi()?.sendPrompt(userMsg.text, sentAttached, sentImages, deliveryMode as any)?.catch?.((err: any) => {
        console.error('[sidebar] sendPrompt error:', err);
      });
    } catch (err) {
      console.error('[sidebar] Failed to call sendPrompt:', err);
    }
  });
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

  let isDragging = false;
  let startX = 0;
  let startWidth = 380;
  let lastTargetWidth = 380;
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
let activeSessionId = 'auto';
let selectedGroup = 'all';
let targetSessionForAction: string | null = null;

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
      sessionMenuDropdown.style.display = 'none';
      try {
        const res = await getApi()?.switchSession('auto');
        if (res && res.messages) {
          messages = res.messages;
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
    item.className = `session-item ${isCurrent ? 'active' : ''}`;

    const isRunning = s.status === 'running';
    const statusIcon = isRunning ? '⏳' : '🟢';
    const statusTitle = isRunning ? 'Đang xử lý' : 'Đã hoàn thành';

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
      pillTitle.textContent = s.title || s.id;
      pillStatusDot.className = `session-status-dot ${isRunning ? 'running' : 'done'}`;
      sessionMenuDropdown.style.display = 'none';
      try {
        const res = await getApi()?.switchSession(s.id);
        if (res && res.messages) {
          messages = res.messages;
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
      } else {
        const sel = cachedSessions.find((s) => s.id === activeSessionId);
        if (sel) {
          pillTitle.textContent = sel.title;
          pillStatusDot.className = `session-status-dot ${sel.status === 'running' ? 'running' : 'done'}`;
        }
      }
      renderSessionDropdownMenu();
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
  await updateSessionDropdown();

  const api = getApi();
  if (!api) return;

  try {
    const state = await api.getInitialState();
    if (state && state.messages) {
      messages = state.messages;
      scheduleRender();
    }
  } catch {}

  api.onStreamUpdate((data: any) => {
    if (data && data.message) {
      const idx = messages.findIndex((m) => m.id === data.message.id);
      if (idx >= 0) {
        messages[idx] = data.message;
      } else {
        messages.push(data.message);
      }
      scheduleRender();
      processMessageQueueIfIdle();
    }
  });

  api.onSessionChanged((data: any) => {
    if (data && data.messages) {
      messages = data.messages;
      scheduleRender();
    }
    updateSessionDropdown().then(() => {
      processMessageQueueIfIdle();
    });
  });

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

/**
 * AntiFan Browser Companion — Chrome Extension Popup Logic
 */

const CANDIDATE_PORTS = [20129, 20130];
let activeBridgePort = 20129;
let activeBridgeToken = '';

const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const cookieCountEl = document.getElementById('cookie-count');
const googleStatusEl = document.getElementById('google-status');
const tokenInput = document.getElementById('bridge-token');
const pasteTokenBtn = document.getElementById('paste-token-btn');
const toggleTokenBtn = document.getElementById('toggle-token-btn');
const syncBtn = document.getElementById('sync-btn');
const resultMessage = document.getElementById('result-message');
const portIndicator = document.getElementById('port-indicator');

function setStatus(type, text) {
  statusBadge.className = `badge ${type}`;
  statusText.textContent = text;
}

function showMessage(type, text) {
  resultMessage.className = `message ${type}`;
  resultMessage.textContent = text;
  resultMessage.classList.remove('hidden');
}

async function discoverBridge() {
  setStatus('checking', 'Đang kết nối...');

  // 1. Load saved token and port from chrome.storage
  const stored = await chrome.storage.local.get(['bridgeToken', 'bridgePort']);
  if (stored.bridgeToken) {
    activeBridgeToken = stored.bridgeToken;
    tokenInput.value = activeBridgeToken;
  }
  if (stored.bridgePort) {
    activeBridgePort = stored.bridgePort;
  }

  // 2. Probe candidate ports via /status
  for (const port of [activeBridgePort, ...CANDIDATE_PORTS]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        activeBridgePort = port;
        setStatus('connected', 'AntiFan Online');
        portIndicator.textContent = `Port: ${port}`;
        chrome.storage.local.set({ bridgePort: port });
        syncBtn.disabled = false;
        return true;
      }
    } catch {}
  }

  setStatus('disconnected', 'Chưa mở AntiFan');
  portIndicator.textContent = `Port: --`;
  syncBtn.disabled = false;
  return false;
}

async function loadCookieStats() {
  try {
    const allCookies = await chrome.cookies.getAll({});
    cookieCountEl.textContent = (allCookies.length || 0).toLocaleString();

    // Check if user is logged into Google/Gmail
    const googleCookies = allCookies.filter(c => 
      c.domain.includes('google.com') || c.domain.includes('youtube.com')
    );
    const hasAuthCookie = googleCookies.some(c => 
      c.name === 'SID' || c.name === 'SSID' || c.name === '__Secure-3PSID' || c.name === 'LOGIN_INFO'
    );

    if (hasAuthCookie) {
      googleStatusEl.textContent = 'Đã đăng nhập';
      googleStatusEl.className = 'stat-value ok';
    } else {
      googleStatusEl.textContent = 'Chưa đăng nhập';
      googleStatusEl.className = 'stat-value';
    }
  } catch (err) {
    cookieCountEl.textContent = '0';
    googleStatusEl.textContent = 'Lỗi';
  }
}

async function syncCookies() {
  syncBtn.disabled = true;
  syncBtn.innerHTML = `<span>Đang đồng bộ...</span>`;
  resultMessage.classList.add('hidden');

  try {
    const token = tokenInput.value.trim() || activeBridgeToken;
    if (token) {
      activeBridgeToken = token;
      chrome.storage.local.set({ bridgeToken: token });
    }

    if (!token) {
      showMessage('error', '⚠️ Vui lòng dán mã Bridge Token từ AntiFan Desktop để xác thực kết nối bảo mật.');
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<span>Đồng bộ ngay sang AntiFan</span>`;
      return;
    }

    const allCookies = await chrome.cookies.getAll({});
    if (!allCookies || allCookies.length === 0) {
      showMessage('error', 'Không tìm thấy cookie nào trong Google Chrome.');
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<span>Đồng bộ ngay sang AntiFan</span>`;
      return;
    }

    const payload = {
      profileName: 'Chrome Live',
      timestamp: Date.now(),
      cookies: allCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      })),
    };

    let syncSuccess = false;
    let lastError = '';

    for (const port of [activeBridgePort, 20129, 20130]) {
      try {
        const url = `http://127.0.0.1:${port}/api/cookies/import`;
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'x-antifan-attachment-secret': token,
        };

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          const resData = await res.json();
          const imported = typeof resData.importedCount === 'number' ? resData.importedCount : 0;
          const skipped = typeof resData.skippedCount === 'number' ? resData.skippedCount : 0;
          const failed = typeof resData.failedCount === 'number' ? resData.failedCount : 0;

          if (imported > 0) {
            showMessage(
              'success',
              `✅ Đã đồng bộ thành công ${imported.toLocaleString()} cookies sang AntiFan! (Bỏ qua ${skipped} cookies hết hạn). Hãy mở Gmail/Google trên AntiFan.`
            );
          } else {
            showMessage(
              'error',
              `⚠️ 0 cookie được nạp (Bỏ qua ${skipped} cookies hết hạn, ${failed} lỗi). Hãy kiểm tra phiên đăng nhập trên Chrome.`
            );
          }
          syncSuccess = true;
          setStatus('connected', 'AntiFan Online');
          portIndicator.textContent = `Port: ${port}`;
          break;
        } else if (res.status === 401) {
          lastError = 'Token không đúng hoặc chưa hợp lệ. Vui lòng kiểm tra lại Bridge Token';
        } else if (res.status === 403) {
          lastError = 'Token không có quyền ghi cookie vào session này';
        } else if (res.status === 413) {
          lastError = 'Dung lượng cookie quá lớn (vượt quá 10MB)';
        } else {
          lastError = `Server phản hồi lỗi (${res.status})`;
        }
      } catch (err) {
        lastError = `Không thể kết nối đến AntiFan Bridge trên port ${port}`;
      }
    }

    if (!syncSuccess) {
      showMessage('error', `❌ ${lastError}. Vui lòng đảm bảo AntiFan Desktop đang mở.`);
    }
  } catch (err) {
    showMessage('error', `Lỗi: ${err.message}`);
  } finally {
    syncBtn.disabled = false;
    syncBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
      </svg>
      <span>Đồng bộ ngay sang AntiFan</span>
    `;
  }
}

// Event Listeners
pasteTokenBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      tokenInput.value = text.trim();
      activeBridgeToken = text.trim();
      chrome.storage.local.set({ bridgeToken: activeBridgeToken });
      showMessage('success', 'Đã dán và lưu Bridge Token!');
    }
  } catch {
    tokenInput.focus();
  }
});

toggleTokenBtn.addEventListener('click', () => {
  if (tokenInput.type === 'password') {
    tokenInput.type = 'text';
    toggleTokenBtn.textContent = '🔒';
  } else {
    tokenInput.type = 'password';
    toggleTokenBtn.textContent = '👁️';
  }
});

tokenInput.addEventListener('change', () => {
  const t = tokenInput.value.trim();
  activeBridgeToken = t;
  chrome.storage.local.set({ bridgeToken: t });
});

syncBtn.addEventListener('click', syncCookies);

// Initialize
discoverBridge();
loadCookieStats();

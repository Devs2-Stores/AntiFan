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
const syncBtn = document.getElementById('sync-btn');
const resultMessage = document.getElementById('result-message');

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
  
  // 1. Check saved token from chrome.storage
  const stored = await chrome.storage.local.get(['bridgeToken', 'bridgePort']);
  if (stored.bridgeToken) {
    activeBridgeToken = stored.bridgeToken;
    tokenInput.value = activeBridgeToken;
  }
  if (stored.bridgePort) {
    activeBridgePort = stored.bridgePort;
  }

  // 2. Probe ports
  for (const port of [activeBridgePort, ...CANDIDATE_PORTS]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(600) });
      if (res.ok) {
        const data = await res.json();
        activeBridgePort = port;
        setStatus('connected', 'AntiFan Online');
        syncBtn.disabled = false;
        
        // Auto-save port
        chrome.storage.local.set({ bridgePort: port });
        return true;
      }
    } catch {}
  }

  setStatus('disconnected', 'Chưa mở AntiFan');
  syncBtn.disabled = false;
  return false;
}

async function loadCookieStats() {
  try {
    const allCookies = await chrome.cookies.getAll({});
    cookieCountEl.textContent = allCookies.length.toLocaleString();

    const googleCookies = allCookies.filter(c => c.domain.includes('google.com') || c.domain.includes('youtube.com'));
    if (googleCookies.length > 0) {
      googleStatusEl.textContent = 'Đã đăng nhập';
      googleStatusEl.style.color = '#34d399';
    } else {
      googleStatusEl.textContent = 'Chưa có';
      googleStatusEl.style.color = '#94a3b8';
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
        const url = `http://127.0.0.1:${port}/api/cookies/import${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });

        if (res.ok) {
          const resData = await res.json();
          showMessage('success', `✅ Đã đồng bộ thành công ${resData.importedCount || allCookies.length} cookies sang AntiFan! Hãy mở tab Gmail/Google để sử dụng.`);
          syncSuccess = true;
          setStatus('connected', 'AntiFan Online');
          break;
        } else if (res.status === 401) {
          lastError = 'Cần nhập Bridge Token xác thực để đồng bộ.';
        } else {
          lastError = `Server lỗi (${res.status})`;
        }
      } catch (err) {
        lastError = 'Không thể kết nối đến AntiFan Bridge (Port ' + port + ')';
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

tokenInput.addEventListener('change', () => {
  const t = tokenInput.value.trim();
  chrome.storage.local.set({ bridgeToken: t });
});

syncBtn.addEventListener('click', syncCookies);

// Initialize
discoverBridge();
loadCookieStats();

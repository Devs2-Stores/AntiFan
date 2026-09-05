/**
 * AntiFan Browser Companion — Chrome Extension Popup Logic (100% Zero-Touch)
 */

const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const cookieCountEl = document.getElementById('cookie-count');
const googleStatusEl = document.getElementById('google-status');
const zeroTouchBanner = document.getElementById('zero-touch-banner');
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

function updateZeroTouchBanner(connected, port, lastError) {
  if (connected) {
    zeroTouchBanner.className = 'zero-touch-banner connected';
    zeroTouchBanner.innerHTML = `
      <div class="zt-icon">⚡</div>
      <div class="zt-text">
        <strong>✓ Đã kết nối tự động Native Bridge</strong>
        <span>Zero-Touch Token xác thực bảo mật (${port ? 'Port ' + port : 'Sẵn sàng'})</span>
      </div>
    `;
  } else {
    zeroTouchBanner.className = 'zero-touch-banner disconnected';
    const detailMsg = lastError ? `Chi tiết: ${lastError}` : 'Mở ứng dụng AntiFan để tự động kích hoạt kết nối';
    zeroTouchBanner.innerHTML = `
      <div class="zt-icon">⚠️</div>
      <div class="zt-text">
        <strong>Chưa kết nối AntiFan Desktop</strong>
        <span>${detailMsg}</span>
      </div>
    `;
  }
}

async function discoverBridge() {
  setStatus('checking', 'Đang kết nối...');

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const bgStatus = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      });

      if (bgStatus && bgStatus.connected && bgStatus.auth?.token) {
        const port = bgStatus.auth.port || 20130;
        setStatus('connected', 'AntiFan Online (Tự động)');
        portIndicator.textContent = `Port: ${port}`;
        updateZeroTouchBanner(true, port);
        syncBtn.disabled = false;
        return true;
      }

      if (bgStatus && bgStatus.lastError) {
        setStatus('disconnected', 'Chưa mở AntiFan');
        portIndicator.textContent = `Port: --`;
        updateZeroTouchBanner(false, null, bgStatus.lastError);
        syncBtn.disabled = false;
        return false;
      }
    }
  } catch {}

  setStatus('disconnected', 'Chưa mở AntiFan');
  portIndicator.textContent = `Port: --`;
  updateZeroTouchBanner(false);
  syncBtn.disabled = false;
  return false;
}

async function loadCookieStats() {
  try {
    if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return;
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
  syncBtn.innerHTML = `<span>Đang đồng bộ sang AntiFan...</span>`;
  resultMessage.classList.add('hidden');

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const syncResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SYNC_ALL_COOKIES' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: false, error: 'NO_RESPONSE' });
          }
        });
      });

      if (syncResult && syncResult.success) {
        showMessage(
          'success',
          `✅ Đã đồng bộ thành công ${syncResult.count.toLocaleString()} cookies sang AntiFan! Hãy mở Google/Gmail trên AntiFan Desktop.`
        );
        setStatus('connected', 'AntiFan Online (Đã đồng bộ)');
        return;
      } else {
        const errMsg = syncResult?.error || 'Không thể đồng bộ';
        if (errMsg === 'NOT_CONNECTED_TO_ANTIFAN' || errMsg === 'BRIDGE_NOT_CONNECTED') {
          showMessage('error', '❌ Chưa mở AntiFan Desktop. Vui lòng mở ứng dụng AntiFan Desktop trước khi đồng bộ.');
        } else {
          showMessage('error', `❌ Lỗi: ${errMsg}`);
        }
      }
    } else {
      showMessage('error', '❌ Không tìm thấy Chrome Extension Runtime.');
    }
  } catch (err) {
    showMessage('error', `❌ Lỗi: ${err.message}`);
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

syncBtn.addEventListener('click', syncCookies);

// Initialize
discoverBridge();
loadCookieStats();

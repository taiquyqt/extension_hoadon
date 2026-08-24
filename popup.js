/**
 * ExtensionHoaDon - Popup Script (Manifest V3)
 * 
 * Script quản lý giao diện tương tác (UI/UX), hỗ trợ phát hiện nguồn dữ liệu (Thuế / MISA),
 * lưu & khôi phục trạng thái (State Persistence) và đồng bộ nút "Treo máy" với Chrome Alarms API.
 */

document.addEventListener('DOMContentLoaded', () => {
  // =========================================================================
  // 1. KHAI BÁO CÁC PHẦN TỬ UI (DOM ELEMENTS)
  // =========================================================================
  const currentUrlEl = document.getElementById('currentUrl');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const envBadge = document.getElementById('envBadge');

  const syncTypeSelect = document.getElementById('syncTypeSelect');
  const startDateInput = document.getElementById('startDateInput');
  const endDateInput = document.getElementById('endDateInput');

  const btnSyncNow = document.getElementById('btnSyncNow');
  const syncIcon = document.getElementById('syncIcon');
  const syncSpinner = document.getElementById('syncSpinner');
  const syncBtnText = document.getElementById('syncBtnText');

  const btnAutoSync = document.getElementById('btnAutoSync');
  const autoSyncBtnText = document.getElementById('autoSyncBtnText');
  const autoSyncPill = document.getElementById('autoSyncPill');

  const btnClearLog = document.getElementById('btnClearLog');
  const logContainer = document.getElementById('logContainer');

  // Trạng thái ứng dụng (State)
  let isSyncing = false;
  let isAutoSyncActive = false;
  let activeTabHostname = 'hoadondientu.gdt.gov.vn';

  // =========================================================================
  // 2. HÀM QUẢN LÝ LƯU & KHÔI PHỤC TRẠNG THÁI (CHROME STORAGE & ALARMS)
  // =========================================================================

  function getDefaultDates() {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    const formatDateStr = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    return {
      startDate: formatDateStr(thirtyDaysAgo),
      endDate: formatDateStr(today)
    };
  }

  function saveUiState() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        syncType: syncTypeSelect ? syncTypeSelect.value : 'MUA_VAO',
        startDate: startDateInput ? startDateInput.value : '',
        endDate: endDateInput ? endDateInput.value : ''
      });
    }
  }

  function updateAutoSyncButtonUi(active) {
    isAutoSyncActive = active;
    if (active) {
      btnAutoSync.classList.add('active');
      autoSyncBtnText.textContent = 'Đang tự động (Treo máy)';
      autoSyncPill.textContent = 'ON';
    } else {
      btnAutoSync.classList.remove('active');
      autoSyncBtnText.textContent = 'Bật tự động (Treo máy)';
      autoSyncPill.textContent = 'OFF';
    }
  }

  function syncAutoSyncButtonWithAlarm(storedFlag) {
    if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.get) {
      chrome.alarms.get('autoSyncAlarm', (alarm) => {
        const isAlarmRunning = !!alarm || !!storedFlag;
        updateAutoSyncButtonUi(isAlarmRunning);
        if (isAlarmRunning) {
          addLog('⏰ Chế độ chạy ngầm đang BẬT (Định kỳ 1 ngày/lần).', 'info');
        }
      });
    } else {
      updateAutoSyncButtonUi(!!storedFlag);
    }
  }

  function restoreUiState() {
    const defaults = getDefaultDates();

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['syncType', 'startDate', 'endDate', 'autoSync'], (res) => {
        if (syncTypeSelect) {
          syncTypeSelect.value = res.syncType || 'MUA_VAO';
        }
        if (startDateInput) {
          startDateInput.value = res.startDate || defaults.startDate;
        }
        if (endDateInput) {
          endDateInput.value = res.endDate || defaults.endDate;
        }
        syncAutoSyncButtonWithAlarm(res.autoSync);
      });
    } else {
      if (startDateInput) startDateInput.value = defaults.startDate;
      if (endDateInput) endDateInput.value = defaults.endDate;
    }
  }

  // =========================================================================
  // 3. CÁC HÀM TIỆN ÍCH HELPER
  // =========================================================================

  function getCurrentTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}]`;
  }

  function addLog(message, type = 'info') {
    const logLine = document.createElement('div');
    logLine.className = `log-line log-type-${type}`;

    const timestampSpan = document.createElement('span');
    timestampSpan.className = 'log-time';
    timestampSpan.textContent = getCurrentTimestamp();

    const contentSpan = document.createElement('span');
    contentSpan.textContent = ` ${message}`;

    logLine.appendChild(timestampSpan);
    logLine.appendChild(contentSpan);

    logContainer.appendChild(logLine);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function updateStatusCard(state, text) {
    statusBadge.className = `status-indicator ${state}`;
    statusText.textContent = text;
  }

  function initCurrentTabUrl() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].url) {
          try {
            const urlObj = new URL(tabs[0].url);
            activeTabHostname = urlObj.hostname;
            currentUrlEl.textContent = activeTabHostname;
            currentUrlEl.title = tabs[0].url;

            if (activeTabHostname.includes('gdt.gov.vn')) {
              if (envBadge) envBadge.textContent = "Thuế điện tử";
              updateStatusCard('ready', 'Sẵn sàng đồng bộ (Thuế)');
              addLog('Phát hiện trang web Tổng cục Thuế hợp lệ.', 'success');
            } else if (activeTabHostname.includes('meinvoice.vn')) {
              if (envBadge) envBadge.textContent = "MISA meInvoice";
              updateStatusCard('ready', 'Sẵn sàng đồng bộ (MISA)');
              addLog('Phát hiện trang web MISA meInvoice hợp lệ.', 'success');
            } else {
              if (envBadge) envBadge.textContent = "Thuế / MISA";
              updateStatusCard('error', 'Vui lòng mở trang Thuế hoặc MISA');
              addLog(`Đang mở: ${activeTabHostname}. Hãy mở hoadondientu.gdt.gov.vn hoặc app3.meinvoice.vn`, 'warn');
            }
          } catch (e) {
            currentUrlEl.textContent = tabs[0].url;
          }
        }
      });
    } else {
      currentUrlEl.textContent = 'hoadondientu.gdt.gov.vn';
      updateStatusCard('ready', 'Sẵn sàng đồng bộ');
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request) => {
      if (request.action === "SYNC_PROGRESS_LOG") {
        addLog(request.message, request.logType || 'info');
      }
    });
  }

  // =========================================================================
  // 4. LẮNG NGHE SỰ KIỆN THAY ĐỔI UI & LƯU VÀO STORAGE (EVENT LISTENERS)
  // =========================================================================

  if (syncTypeSelect) {
    syncTypeSelect.addEventListener('change', saveUiState);
  }
  if (startDateInput) {
    startDateInput.addEventListener('change', saveUiState);
  }
  if (endDateInput) {
    endDateInput.addEventListener('change', saveUiState);
  }

  /**
   * Nút 1: "Đồng bộ ngay" (Truyền sourceDomain để background.js điều hướng Routing)
   */
  btnSyncNow.addEventListener('click', () => {
    if (isSyncing) return;

    const startDate = startDateInput ? startDateInput.value : '';
    const endDate = endDateInput ? endDateInput.value : '';
    const syncType = syncTypeSelect ? syncTypeSelect.value : 'MUA_VAO';

    if (!startDate || !endDate) {
      addLog('⚠️ Vui lòng chọn khoảng thời gian (Từ ngày - Đến ngày).', 'warn');
      return;
    }

    saveUiState();

    isSyncing = true;
    btnSyncNow.disabled = true;
    syncIcon.classList.add('hidden');
    syncSpinner.classList.remove('hidden');
    syncBtnText.textContent = 'Đang đồng bộ...';

    updateStatusCard('working', 'Đang xử lý đồng bộ...');

    const typeLabel = syncType === 'BAN_RA' ? 'BÁN RA' : 'MUA VÀO';
    const sourceLabel = activeTabHostname.includes('meinvoice.vn') ? 'MISA meInvoice' : 'Tổng cục Thuế';
    addLog(`🔍 Bắt đầu yêu cầu đồng bộ [${sourceLabel}] - [${typeLabel}] từ ${startDate} đến ${endDate}...`, 'process');

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: "START_FULL_SYNC",
        startDate: startDate,
        endDate: endDate,
        syncType: syncType,
        sourceDomain: activeTabHostname
      }, (response) => {
        isSyncing = false;
        btnSyncNow.disabled = false;
        syncSpinner.classList.add('hidden');
        syncIcon.classList.remove('hidden');
        syncBtnText.textContent = 'Đồng bộ ngay';

        updateStatusCard('ready', 'Sẵn sàng đồng bộ');

        if (response && response.success) {
          addLog('🎉 Đã hoàn tất luồng đồng bộ từ background Service Worker.', 'success');
        } else if (response && response.error) {
          addLog(`❌ Lỗi: ${response.error}`, 'error');
        }
      });
    } else {
      setTimeout(() => addLog('🔍 [Mock] Đang tải dữ liệu hóa đơn...', 'info'), 800);
      setTimeout(() => addLog('🔑 [Mock] Đọc Cookie phiên đăng nhập...', 'process'), 1800);
      setTimeout(() => addLog('📤 [Mock] Check-before-Insert dữ liệu hóa đơn vào Supabase...', 'info'), 3200);
      setTimeout(() => {
        addLog('✅ [Mock] Đồng bộ thành công!', 'success');
        isSyncing = false;
        btnSyncNow.disabled = false;
        syncSpinner.classList.add('hidden');
        syncIcon.classList.remove('hidden');
        syncBtnText.textContent = 'Đồng bộ ngay';
        updateStatusCard('ready', 'Sẵn sàng đồng bộ');
      }, 4500);
    }
  });

  /**
   * Nút 2: "Bật tự động (Treo máy)"
   */
  btnAutoSync.addEventListener('click', () => {
    const nextState = !isAutoSyncActive;
    updateAutoSyncButtonUi(nextState);

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ autoSync: nextState });
    }

    if (typeof chrome !== 'undefined' && chrome.alarms) {
      if (nextState) {
        chrome.alarms.create('autoSyncAlarm', { periodInMinutes: 1440 });
        addLog('⏰ Đã BẬT chế độ chạy ngầm tự động (Định kỳ 1 ngày/lần via Chrome Alarms).', 'warn');
        addLog('💡 Extension sẽ tự động kiểm tra hóa đơn mới mỗi ngày một lần.', 'info');
      } else {
        chrome.alarms.clear('autoSyncAlarm');
        addLog('🛑 Đã TẮT chế độ tự động đồng bộ ngầm.', 'info');
      }
    } else {
      if (nextState) {
        addLog('⏰ Đã BẬT chế độ tự động đồng bộ (Giả lập UI).', 'warn');
      } else {
        addLog('🛑 Đã TẮT chế độ tự động đồng bộ (Giả lập UI).', 'info');
      }
    }
  });

  /**
   * Nút Xóa nhật ký (Clear Log)
   */
  btnClearLog.addEventListener('click', () => {
    logContainer.innerHTML = '';
    addLog('🧹 Đã xóa nhật ký tiến trình.', 'info');
  });

  // =========================================================================
  // 5. KHỞI CHẠY LẦN ĐẦU (INITIALIZATION ON DOMContentLoaded)
  // =========================================================================
  restoreUiState();
  initCurrentTabUrl();

  addLog('🟢 ExtensionHoaDon đã sẵn sàng.', 'success');
  addLog('ℹ️ Chọn Loại hóa đơn, Ngày tra cứu và nhấn "Đồng bộ ngay".', 'info');
});

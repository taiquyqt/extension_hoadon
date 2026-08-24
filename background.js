/**
 * ExtensionHoaDon - Background Service Worker (Manifest V3)
 * 
 * Tự động đồng bộ hóa đơn từ 2 nguồn dữ liệu:
 * 1. Tổng cục Thuế (hoadondientu.gdt.gov.vn)
 * 2. MISA meInvoice (app3.meinvoice.vn)
 * 
 * Tích hợp chuẩn hóa UUID v5, Routing theo domain và luồng Check-before-Insert an toàn 100%.
 */

// =========================================================================
// 1. HẰNG SỐ API & CẤU HÌNH (API ENDPOINTS & CONFIGS)
// =========================================================================

// Template API Thuế Mua vào & Bán ra (size=50)
const API_MUA_VAO_TEMPLATE = "https://hoadondientu.gdt.gov.vn/api/query/invoices/purchase?sort=tdlap:desc&size=50&search=tdlap=ge=[START_DATE]T00:00:00;tdlap=le=[END_DATE]T23:59:59;ttxly==5";
const API_BAN_RA_TEMPLATE  = "https://hoadondientu.gdt.gov.vn/api/query/invoices/sold?sort=tdlap:desc&size=50&search=tdlap=ge=[START_DATE]T00:00:00;tdlap=le=[END_DATE]T23:59:59";

// API Endpoint MISA meInvoice
const API_MISA_LIST_ENDPOINT = "https://app3.meinvoice.vn/v3/sainvoicewithcode/list";

// Cấu hình thông tin Supabase dự án (Đã nạp URL & Anon Key thực tế)
const SUPABASE_URL      = "https://hoadon.db.markeeai.com";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg1NDk2NTc2LCJleHAiOjIxMDA4NTY1NzZ9.68gsZv00HBkHTDNYGIZ3Rr0rwKYlxwagdYtV8G0TkPc";

// Namespace UUID cố định cho RFC 4122 UUID v5 (DNS Namespace)
const INVOICE_NAMESPACE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";


// =========================================================================
// 2. LOGIC LẤY COOKIES / AUTHENTICATION HEADERS (THUẾ)
// =========================================================================

/**
 * Lấy Token JWT từ Cookie của trang hoadondientu.gdt.gov.vn
 */
async function getTaxAuthHeaders() {
  if (typeof chrome === 'undefined' || !chrome.cookies || !chrome.cookies.get) {
    console.warn("[getTaxAuthHeaders] Môi trường không hỗ trợ chrome.cookies API (Giả lập).");
    return {
      'Authorization': 'Bearer mock_token',
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*'
    };
  }

  const cookie = await chrome.cookies.get({
    url: 'https://hoadondientu.gdt.gov.vn',
    name: 'jwt'
  });

  if (!cookie || !cookie.value) {
    throw new Error("Không tìm thấy Cookie JWT (tên 'jwt'). Vui lòng đăng nhập trang Thuế tại https://hoadondientu.gdt.gov.vn!");
  }

  const token = cookie.value;

  return {
    'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
  };
}


// =========================================================================
// 3. THUẬT TOÁN DATE CHUNKING (TỐI ĐA 31 NGÀY / CHUNK - THUẾ)
// =========================================================================

function generateDateChunks(startDate, endDate) {
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error("Ngày bắt đầu hoặc kết thúc không hợp lệ.");
    }

    if (start > end) {
      throw new Error("Ngày bắt đầu không được lớn hơn ngày kết thúc.");
    }

    const chunks = [];
    let currentStart = new Date(start);

    while (currentStart <= end) {
      let currentEnd = new Date(currentStart);
      currentEnd.setDate(currentStart.getDate() + 30);

      if (currentEnd > end) {
        currentEnd = new Date(end);
      }

      chunks.push({
        startDateStr: formatDateDDMMYYYY(currentStart),
        endDateStr: formatDateDDMMYYYY(currentEnd)
      });

      currentStart = new Date(currentEnd);
      currentStart.setDate(currentStart.getDate() + 1);
    }

    return chunks;
  } catch (error) {
    console.error("[generateDateChunks] Lỗi:", error);
    throw error;
  }
}

function formatDateDDMMYYYY(dateInput) {
  if (!dateInput) return "";
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  } catch (e) {
    return String(dateInput);
  }
}


// =========================================================================
// 4. FETCH DỮ LIỆU TỪ 2 NGUỒN (THUẾ & MISA MEINVOICE)
// =========================================================================

/**
 * LUỒNG 1: Gọi API Tổng cục Thuế (hoadondientu.gdt.gov.vn)
 */
async function fetchTaxInvoices(type = 'MUA_VAO', chunks = [], onProgressCallback = null) {
  const allInvoices = [];
  const template = type === 'BAN_RA' ? API_BAN_RA_TEMPLATE : API_MUA_VAO_TEMPLATE;

  const authHeaders = await getTaxAuthHeaders();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const targetUrl = template
      .replace("[START_DATE]", chunk.startDateStr)
      .replace("[END_DATE]", chunk.endDateStr);

    const logMsg = `Đang tải API Thuế [${type === 'BAN_RA' ? 'Bán ra' : 'Mua vào'}] (size=50) từ ${chunk.startDateStr} đến ${chunk.endDateStr} (${i + 1}/${chunks.length})...`;
    console.log(`[fetchTaxInvoices] ${logMsg}`);

    if (onProgressCallback) {
      onProgressCallback(logMsg, 'process');
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: authHeaders
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Lỗi 401 (Unauthorized): Cookie JWT hết hạn. Vui lòng đăng nhập lại hoadondientu.gdt.gov.vn!");
        }
        if (response.status === 500) {
          throw new Error("Lỗi 500 (Internal Server Error): Máy chủ Thuế không xử lý được request!");
        }
        throw new Error(`Mã lỗi HTTP Thuế [${response.status}]: ${response.statusText}`);
      }

      const resJson = await response.json();
      const invoiceList = resJson.datas || resJson.items || [];
      console.log(`[fetchTaxInvoices] Đã lấy thành công ${invoiceList.length} hóa đơn cho chunk (${chunk.startDateStr} - ${chunk.endDateStr}).`);

      allInvoices.push(...invoiceList);

    } catch (error) {
      console.error(`[fetchTaxInvoices] Lỗi truy vấn Thuế (${chunk.startDateStr} - ${chunk.endDateStr}):`, error);
      if (onProgressCallback) {
        onProgressCallback(`⚠️ Lỗi tải khoảng ${chunk.startDateStr} - ${chunk.endDateStr}: ${error.message}`, 'warn');
      }
      if (error.message.includes("401") || error.message.includes("500") || error.message.includes("Cookie JWT")) {
        throw error;
      }
    }

    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  return allInvoices;
}

/**
 * LUỒNG 2: Gọi API MISA meInvoice (app3.meinvoice.vn/v3/sainvoicewithcode/list)
 */
async function fetchMisaInvoices(startDateStr, endDateStr, syncType = 'BAN_RA', onProgressCallback = null) {
  const sendLog = (msg, type = 'info') => {
    console.log(`[fetchMisaInvoices] ${msg}`);
    if (onProgressCallback) onProgressCallback(msg, type);
  };

  sendLog(`🔍 Kết nối API MISA meInvoice (app3.meinvoice.vn)...`, 'process');

  // Thử nghiệm định dạng ngày chuẩn ISO không chứa Z (YYYY-MM-DDTHH:mm:ss.000Z)
  const fromIso = `${startDateStr}T00:00:00.000Z`;
  const toIso = `${endDateStr}T23:59:59.000Z`;

  const requestBody = new URLSearchParams({
    draw: 1,
    fromDate: fromIso,
    toDate: toIso,
    publishStatus: -1,
    sendEmailStatus: -1,
    filterInvoiceStatus: -1, // Tất cả trạng thái hóa đơn (thay vì 0)
    sendToTaxStatus: -1,
    invoiceSummaryStatus: -2,
    searchField: "InvNo",
    filterCustomField: false
  }).toString();

  console.log("🔍 [Debug MISA Request Body]:", requestBody);

  try {
    const response = await fetch(API_MISA_LIST_ENDPOINT, {
      method: "POST",
      credentials: "include", // Tự động đính kèm Cookie phiên MISA
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: requestBody
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Lỗi 401: Phiên đăng nhập MISA meInvoice đã hết hạn. Vui lòng đăng nhập lại app3.meinvoice.vn!");
      }
      throw new Error(`Lỗi HTTP MISA API [${response.status}]: ${response.statusText}`);
    }

    const rawText = await response.text();
    console.log("🔍 [Debug MISA Raw Text Response]:", rawText.substr(0, 500));

    if (rawText.trim().startsWith('<')) {
      sendLog(`❌ Lỗi MISA trả về HTML thay vì JSON. Chi tiết xem trong Console (F12).`, 'error');
      console.error("[fetchMisaInvoices] Server MISA trả về HTML:", rawText);
      return [];
    }

    let responseJson = {};
    try {
      responseJson = JSON.parse(rawText);
    } catch (parseErr) {
      sendLog(`❌ Lỗi parse JSON từ server MISA. Chi tiết xem trong Console (F12).`, 'error');
      console.error("[fetchMisaInvoices] Lỗi parse JSON:", parseErr, rawText);
      return [];
    }
    
    // Parse 2 lớp cho responseJson.data của MISA
    let invoiceArray = [];
    if (responseJson && responseJson.data) {
      invoiceArray = typeof responseJson.data === 'string' ? JSON.parse(responseJson.data) : responseJson.data;
    } else if (Array.isArray(responseJson)) {
      invoiceArray = responseJson;
    }

    console.log("🔍 [Debug] Đã lấy được data MISA, số lượng:", invoiceArray.length);
    sendLog(`📄 Thu thập thành công ${invoiceArray.length} hóa đơn từ MISA meInvoice.`, 'info');

    // MAP DỮ LIỆU MISA SANG CẤU TRÚC CHUẨN
    const mappedInvoices = invoiceArray.map(misaInv => {
      const invDateStr = misaInv.InvDate ? (typeof misaInv.InvDate === 'string' ? misaInv.InvDate.split('T')[0] : misaInv.InvDate) : "";
      
      return {
        mstNguoiBan: "0402336899", // MST công ty bán ra
        mstNguoiMua: misaInv.AccountObjectTaxCode || "",
        tdlap: invDateStr,
        tgtttbso: Number(misaInv.TotalAmount) || 0,
        soHoaDon: misaInv.InvNo ? misaInv.InvNo.toString() : "", 
        kyHieuHoaDon: misaInv.InvSeries || "",
        misaRawData: misaInv 
      };
    });

    return mappedInvoices;

  } catch (error) {
    console.error("[fetchMisaInvoices] Lỗi khi gọi API MISA:", error);
    sendLog(`❌ Lỗi MISA meInvoice: ${error.message}`, 'error');
    throw error;
  }
}


// =========================================================================
// 5. DATA MAPPING & DEDUPLICATION (DETERMINISTIC UUID v5 & PAYLOAD SUPABASE)
// =========================================================================

function uuidToBytes(uuidStr) {
  const hex = uuidStr.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function generateUUIDv5(inputStr) {
  const namespaceBytes = uuidToBytes(INVOICE_NAMESPACE_UUID);
  const textEncoder = new TextEncoder();
  const inputBytes = textEncoder.encode(inputStr || "");

  const combinedBuffer = new Uint8Array(namespaceBytes.length + inputBytes.length);
  combinedBuffer.set(namespaceBytes, 0);
  combinedBuffer.set(inputBytes, namespaceBytes.length);

  const hashBuffer = await crypto.subtle.digest('SHA-1', combinedBuffer);
  const hashArray = new Uint8Array(hashBuffer);

  hashArray[6] = (hashArray[6] & 0x0f) | 0x50;
  hashArray[8] = (hashArray[8] & 0x3f) | 0x80;

  const hex = Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
}

async function mapToSupabasePayload(taxData) {
  try {
    const mstNguoiBan = taxData.mstNguoiBan || taxData.nbmst || "";
    const mstNguoiMua = taxData.mstNguoiMua || taxData.nmmst || taxData.maSoThue || "";
    
    // Đảm bảo tdlap lấy đúng phần ngày YYYY-MM-DD
    let tdlapStr = "";
    if (taxData.tdlap) {
      if (typeof taxData.tdlap === 'string') {
        if (taxData.tdlap.includes('T')) {
          tdlapStr = taxData.tdlap.split('T')[0];
        } else if (taxData.tdlap.includes(' ')) {
          tdlapStr = taxData.tdlap.split(' ')[0];
        } else {
          tdlapStr = taxData.tdlap;
        }
      }
    }

    const tgtttbso = Number(taxData.tgtttbso || taxData.tongTien) || 0;
    const soHoaDon = taxData.soHoaDon ? taxData.soHoaDon.toString() : (taxData.shdon ? taxData.shdon.toString() : "");
    const kyHieuHoaDon = taxData.kyHieuHoaDon || taxData.khhdon || "";

    // UUID v5 cố định theo key: mstNguoiBan + kyHieuHoaDon + soHoaDon
    const rawInputKey = `${mstNguoiBan}${kyHieuHoaDon}${soHoaDon}`;
    const invoiceUuid = await generateUUIDv5(rawInputKey);

    const isoNow = new Date().toISOString();

    const dataContent = {
      "id": invoiceUuid,
      "soHoaDon": soHoaDon,
      "nguonDuLieu": taxData.misaRawData ? "MISA_MEINVOICE" : "CO_QUAN_THUE",
      "kyHieuHoaDon": kyHieuHoaDon,
      "ngay": formatDateDDMMYYYY(taxData.tdlap),
      "tdlap": tdlapStr,
      "khachHang": taxData.nmten || taxData.khachHang || "",
      "maSoThue": mstNguoiMua,
      "mstNguoiMua": mstNguoiMua,
      "diaChi": taxData.nbdchi || taxData.diaChi || "", 
      "trangThai": "Hóa đơn mới",
      "nguoiBan": taxData.nbten || taxData.nguoiBan || "",
      "mstNguoiBan": mstNguoiBan,
      "mauSo": "1",
      "donViTienTe": taxData.dvtte || "VND",
      "ketQuaKiemTra": "Đã cấp mã hóa đơn",
      "trangThaiPhatHanh": "Đã cấp mã",
      "items": taxData.items || [],
      "tongTien": tgtttbso,
      "tgtttbso": tgtttbso,
      "tongTruocThue": taxData.tgtcthue || taxData.tongTruocThue || 0,
      "workspaceId": "default",
      "coNoiBo": false,
      "coCoQuanThue": true,
      "thieu": ["Category", "Bộ phận", "Dự án"],
      "phanTram": 40,
      "sanSangXacMinh": false,
      ...(taxData.misaRawData ? { misaRawData: taxData.misaRawData } : {})
    };

    return {
      "id": invoiceUuid,
      "workspaceId": "default",
      "createdAt": isoNow,
      "updatedAt": isoNow,
      "data": JSON.stringify(dataContent)
    };
  } catch (error) {
    console.error("[mapToSupabasePayload] Lỗi map dữ liệu hóa đơn:", error, taxData);
    throw error;
  }
}


// =========================================================================
// 6. LUỒNG CHECK-BEFORE-INSERT CHỐNG LỖI 409 DUPLICATE KEY 100%
// =========================================================================

async function syncToSupabase(payloadArray, syncType = 'MUA_VAO', onProgressCallback = null) {
  const sendLog = (msg, type = 'info') => {
    console.log(`[SupabaseSync] ${msg}`);
    if (onProgressCallback) onProgressCallback(msg, type);
  };

  if (!payloadArray || payloadArray.length === 0) {
    sendLog("Không có dữ liệu hóa đơn nào để đồng bộ.", "warn");
    return { success: true, addedCount: 0, skippedCount: 0 };
  }

  let addedCount = 0;
  let skippedCount = 0;
  const typeLabel = syncType === 'BAN_RA' ? 'BÁN RA' : 'MUA VÀO';

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.trim() === "") {
    sendLog("⚠️ Chưa cấu hình SUPABASE_URL hoặc SUPABASE_ANON_KEY. Chế độ Mock.", "warn");
    for (let i = 0; i < payloadArray.length; i++) {
      if (i % 2 === 0) {
        addedCount++;
        sendLog(`[Thêm mới] Hóa đơn số ${i + 1} đã được lưu (Mock).`, "success");
      } else {
        skippedCount++;
        sendLog(`[Bỏ qua] Hóa đơn số ${i + 1} đã có trong hệ thống (Mock).`, "warn");
      }
    }
    const summaryMsg = `✅ Hoàn tất đồng bộ [${typeLabel}]: Thêm mới ${addedCount} hóa đơn, Bỏ qua ${skippedCount} hóa đơn trùng lặp.`;
    sendLog(summaryMsg, "success");
    return { success: true, addedCount, skippedCount, isMock: true };
  }

  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const invoiceRawEndpoint = `${baseUrl}/rest/v1/InvoiceRaw`;

  const commonHeaders = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Accept': 'application/json'
  };

  sendLog(`🔍 Bắt đầu kiểm tra chống trùng lặp tuyệt đối cho ${payloadArray.length} hóa đơn...`, 'process');

  for (let i = 0; i < payloadArray.length; i++) {
    const payload = payloadArray[i];

    let parsedData = {};
    try {
      parsedData = typeof payload.data === 'string' ? JSON.parse(payload.data) : (payload.data || {});
    } catch (e) {
      parsedData = payload.data || {};
    }

    const soHoaDon = parsedData.soHoaDon || "";
    const kyHieuHoaDon = parsedData.kyHieuHoaDon || "";
    const mstNguoiBan = parsedData.mstNguoiBan || "";
    const displaySoHD = soHoaDon || `Row #${i+1}`;

    try {
      // 1. TRUY VẤN KIỂM TRA TỒN TẠI (KIỂM TRA BẰNG ID HOẶC SỐ/KÝ HIỆU/MST HÓA ĐƠN)
      // Query này lọc cả id = payload.id HOẶC (soHoaDon + kyHieuHoaDon + mstNguoiBan)
      const checkUrl = `${invoiceRawEndpoint}?select=id&or=(id.eq.${payload.id},and(data->>soHoaDon.eq.${encodeURIComponent(soHoaDon)},data->>kyHieuHoaDon.eq.${encodeURIComponent(kyHieuHoaDon)},data->>mstNguoiBan.eq.${encodeURIComponent(mstNguoiBan)}))`;

      const checkResponse = await fetch(checkUrl, {
        method: 'GET',
        headers: commonHeaders
      });

      if (!checkResponse.ok) {
        const errorText = await checkResponse.text();
        sendLog(`⚠️ Lỗi khi tra cứu DB hóa đơn số ${displaySoHD}: ${errorText}`, 'error');
        continue;
      }

      const existingRecords = await checkResponse.json();

      if (!Array.isArray(existingRecords)) {
        sendLog(`⚠️ Dữ liệu trả về khi tra cứu hóa đơn ${displaySoHD} không đúng cấu trúc mảng. Bỏ qua!`, 'error');
        continue;
      }

      // NẾU ĐÃ TỒN TẠI RECORD -> BỎ QUA (SKIP)
      if (existingRecords.length > 0) {
        skippedCount++;
        sendLog(`[Bỏ qua] Hóa đơn số ${displaySoHD} (Ký hiệu: ${kyHieuHoaDon}, MST: ${mstNguoiBan}) đã có trong hệ thống.`, 'warn');
      } else {
        // NẾU CHƯA TỒN TẠI -> THÊM MỚI (VỚI HEADER RESOLUTION=IGNORE-DUPLICATES ĐỂ CHẶN TRIỆT ĐỂ LỖI 409)
        const insertResponse = await fetch(invoiceRawEndpoint, {
          method: 'POST',
          headers: {
            ...commonHeaders,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates' // Tránh lỗi 409 nếu trùng khoá chính
          },
          body: JSON.stringify(payload)
        });

        if (!insertResponse.ok) {
          if (insertResponse.status === 409) {
            skippedCount++;
            sendLog(`[Bỏ qua] Hóa đơn số ${displaySoHD} (Trùng khóa chính ID).`, 'warn');
            continue;
          }
          const insertErrText = await insertResponse.text();
          throw new Error(`Lỗi POST thêm mới [${insertResponse.status}]: ${insertErrText}`);
        }

        addedCount++;
        sendLog(`[Thêm mới] Hóa đơn số ${displaySoHD} (Ký hiệu: ${kyHieuHoaDon}) đã được lưu.`, 'success');
      }

    } catch (itemError) {
      console.error(`[syncToSupabase] Lỗi xử lý hóa đơn ${displaySoHD}:`, itemError);
      sendLog(`⚠️ Lỗi xử lý hóa đơn ${displaySoHD}: ${itemError.message}`, 'error');
    }
  }

  const summaryLog = `✅ Hoàn tất đồng bộ [${typeLabel}]: Thêm mới ${addedCount} hóa đơn, Bỏ qua ${skippedCount} hóa đơn trùng lặp.`;
  sendLog(summaryLog, 'success');

  return {
    success: true,
    addedCount,
    skippedCount
  };
}


// =========================================================================
// 7. CHẠY TOÀN BỘ QUY TRÌNH & ĐIỀU HƯỚNG ROUTING
// =========================================================================

async function runFullSyncProcess(startDateStr, endDateStr, syncType = 'MUA_VAO', sourceDomain = '', logCallback = null) {
  const sendLog = (msg, type = 'info') => {
    console.log(`[SyncEngine] ${msg}`);
    if (logCallback) logCallback(msg, type);
  };

  try {
    const typeLabel = syncType === 'BAN_RA' ? 'BÁN RA' : 'MUA VÀO';
    let rawInvoices = [];

    if (sourceDomain && sourceDomain.includes('meinvoice.vn')) {
      if (syncType !== 'BAN_RA') {
        sendLog(`ℹ️ Phân hệ MISA meInvoice chỉ chứa Hóa đơn Bán ra. Hệ thống tự động bỏ qua luồng Mua vào.`, 'warn');
        return { success: true, addedCount: 0, skippedCount: 0 };
      }

      sendLog(`🚀 Bắt đầu quy trình đồng bộ MISA meInvoice [${typeLabel}] từ ${startDateStr} đến ${endDateStr}...`, 'process');
      rawInvoices = await fetchMisaInvoices(startDateStr, endDateStr, syncType, sendLog);
    } else {
      sendLog(`🚀 Bắt đầu quy trình đồng bộ Tổng cục Thuế [${typeLabel}] từ ${startDateStr} đến ${endDateStr}...`, 'process');

      sendLog(`🔑 Đang đọc Cookie 'jwt' từ domain hoadondientu.gdt.gov.vn...`, 'info');
      await getTaxAuthHeaders();
      sendLog(`✅ Xác thực JWT Token Cookie thành công.`, 'success');

      const chunks = generateDateChunks(startDateStr, endDateStr);
      sendLog(`📊 Đã chia khoảng thời gian thành ${chunks.length} chu kỳ tra cứu (Tối đa 31 ngày/chu kỳ)...`, 'info');

      rawInvoices = await fetchTaxInvoices(syncType, chunks, sendLog);
    }

    sendLog(`📄 Thu thập tổng cộng ${rawInvoices.length} bản ghi hóa đơn.`, 'info');

    if (rawInvoices.length === 0) {
      sendLog(`ℹ️ Không có hóa đơn nào mới trong khoảng thời gian tra cứu.`, 'warn');
      return { success: true, addedCount: 0, skippedCount: 0 };
    }

    sendLog(`⏳ Đang khởi tạo mã UUID v5 & chuẩn hóa Payload...`, 'process');
    const payloadArray = [];
    for (const itemData of rawInvoices) {
      const payload = await mapToSupabasePayload(itemData);
      payloadArray.push(payload);
    }

    sendLog(`📤 Đang kiểm tra trùng lặp & đồng bộ ${payloadArray.length} hóa đơn lên Supabase...`, 'process');
    const syncResult = await syncToSupabase(payloadArray, syncType, sendLog);

    return syncResult;

  } catch (error) {
    sendLog(`❌ THẤT BẠI: ${error.message}`, 'error');
    throw error;
  }
}

// Lắng nghe sự kiện Chrome Alarms
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'autoSyncAlarm') {
      console.log("[Background] Chrome Alarm 'autoSyncAlarm' kích hoạt! Đang chạy tự động đồng bộ ngầm (Định kỳ 1 ngày/lần)...");
      const endDate = new Date().toISOString().split('T')[0];
      const startDateDate = new Date();
      startDateDate.setDate(startDateDate.getDate() - 15);
      const startDate = startDateDate.toISOString().split('T')[0];

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['syncType'], (res) => {
          const syncType = res.syncType || 'MUA_VAO';
          runFullSyncProcess(startDate, endDate, syncType, 'hoadondientu.gdt.gov.vn', (msg, type) => {
            console.log(`[AutoSync-Alarm] ${msg}`);
            chrome.runtime.sendMessage({
              action: "SYNC_PROGRESS_LOG",
              message: `[Tự động ngầm] ${msg}`,
              logType: type
            }).catch(() => {});
          }).catch(err => {
            console.error("[AutoSync-Alarm] Lỗi khi chạy tự động ngầm:", err);
          });
        });
      }
    }
  });
}

// Lắng nghe thông điệp từ Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_FULL_SYNC") {
    const { startDate, endDate, syncType, sourceDomain } = request;

    runFullSyncProcess(
      startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0],
      endDate || new Date().toISOString().split('T')[0],
      syncType || 'MUA_VAO',
      sourceDomain || 'hoadondientu.gdt.gov.vn',
      (msg, type) => {
        chrome.runtime.sendMessage({
          action: "SYNC_PROGRESS_LOG",
          message: msg,
          logType: type
        }).catch(() => {});
      }
    ).then(result => {
      sendResponse({ success: true, result });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });

    return true; // Giữ kênh giao tiếp bất đồng bộ sendResponse
  }
});

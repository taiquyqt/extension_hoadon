/**
 * ExtensionHoaDon - Background Service Worker (Manifest V3)
 * 
 * Tự động đồng bộ hóa đơn từ 2 nguồn dữ liệu:
 * 1. Tổng cục Thuế (hoadondientu.gdt.gov.vn)
 * 2. MISA meInvoice (app3.meinvoice.vn)
 * 
 * Tích hợp chuẩn hóa UUID v5, Routing theo domain và luồng "Check-before-Insert" vào Supabase.
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
// 2. LOGIC LẤY COOKIES / AUTHENTICATION HEADERS (THUẾ & MISA)
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

/**
 * Lấy toàn bộ Cookie của trang MISA meInvoice (meinvoice.vn)
 * Nối tất cả Cookie lại thành chuỗi dạng `name=value; name2=value2`
 */
async function getMisaCookies() {
  if (typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.getAll) {
    try {
      const cookies = await chrome.cookies.getAll({ domain: "meinvoice.vn" });
      if (cookies && cookies.length > 0) {
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (e) {
      console.warn("[getMisaCookies] Không lấy được Cookie MISA:", e.message);
    }
  }
  return "";
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
 * 
 * @param {string} startDateStr - Ngày bắt đầu YYYY-MM-DD
 * @param {string} endDateStr - Ngày kết thúc YYYY-MM-DD
 * @param {'MUA_VAO' | 'BAN_RA'} syncType - Loại hóa đơn
 * @param {function} onProgressCallback - Callback ghi log
 * @returns {Promise<Array<Object>>} Mảng các đối tượng hóa đơn đã được map theo chuẩn Thuế
 */
async function fetchMisaInvoices(startDateStr, endDateStr, syncType = 'MUA_VAO', onProgressCallback = null) {
  const sendLog = (msg, type = 'info') => {
    console.log(`[fetchMisaInvoices] ${msg}`);
    if (onProgressCallback) onProgressCallback(msg, type);
  };

  sendLog(`🔍 Kết nối API MISA meInvoice (app3.meinvoice.vn)...`, 'process');

  // Lấy chuỗi Cookie MISA
  const cookieHeader = await getMisaCookies();
  if (!cookieHeader) {
    sendLog(`⚠️ Không tìm thấy Cookie MISA meInvoice. Vui lòng mở trang và đăng nhập tại https://app3.meinvoice.vn!`, 'warn');
  }

  // Chuyển đổi ngày từ YYYY-MM-DD sang định dạng chuẩn ISO String
  const fromIso = new Date(`${startDateStr}T00:00:00.000Z`).toISOString();
  const toIso = new Date(`${endDateStr}T23:59:59.000Z`).toISOString();

  // Đóng gói tham số body URLSearchParams (application/x-www-form-urlencoded)
  const bodyParams = new URLSearchParams();
  bodyParams.append('draw', '1');
  bodyParams.append('fromDate', fromIso);
  bodyParams.append('toDate', toIso);
  bodyParams.append('publishStatus', '-1');
  bodyParams.append('sendEmailStatus', '-1');
  bodyParams.append('filterInvoiceStatus', '0');
  bodyParams.append('sendToTaxStatus', '-1');
  bodyParams.append('invoiceSummaryStatus', '-2');
  bodyParams.append('searchField', 'InvNo');
  bodyParams.append('filterCustomField', 'false');

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  try {
    const response = await fetch(API_MISA_LIST_ENDPOINT, {
      method: 'POST',
      headers: headers,
      body: bodyParams.toString(),
      credentials: 'include'
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Lỗi 401: Phiên đăng nhập MISA meInvoice đã hết hạn. Vui lòng đăng nhập lại app3.meinvoice.vn!");
      }
      throw new Error(`Lỗi HTTP MISA API [${response.status}]: ${response.statusText}`);
    }

    const resJson = await response.json();
    
    // Giải mã dữ liệu MISA (response.data có thể là chuỗi JSON string)
    let rawMisaArray = [];
    if (resJson && resJson.data) {
      if (typeof resJson.data === 'string') {
        try {
          rawMisaArray = JSON.parse(resJson.data);
        } catch (e) {
          console.error("[fetchMisaInvoices] Lỗi parse JSON string từ MISA:", e);
          rawMisaArray = [];
        }
      } else if (Array.isArray(resJson.data)) {
        rawMisaArray = resJson.data;
      }
    } else if (Array.isArray(resJson)) {
      rawMisaArray = resJson;
    }

    sendLog(`📄 Thu thập thành công ${rawMisaArray.length} hóa đơn từ MISA meInvoice.`, 'info');

    // YÊU CẦU 3: MAP TỪNG HÓA ĐƠN MISA SANG CẤU TRÚC CHUẨN ĐỂ SO SÁNH CHỐNG TRÙNG LẶP
    const mappedInvoices = rawMisaArray.map(misaInv => {
      return {
        // 3 Trường khóa chính chống trùng lặp (BẮT BUỘC)
        soHoaDon: misaInv.InvNo ? misaInv.InvNo.toString() : "",
        kyHieuHoaDon: misaInv.InvSeries || "",
        mstNguoiBan: "0402336899", // Gắn cứng tạm thời MST của công ty Bán ra theo yêu cầu
        
        // Các trường dữ liệu bổ sung
        mstNguoiMua: misaInv.AccountObjectTaxCode || "",
        nmmst: misaInv.AccountObjectTaxCode || "",
        tdlap: misaInv.InvDate || new Date().toISOString(),
        tgtttbso: misaInv.TotalAmount || 0,
        tgtcthue: misaInv.TotalAmountBeforeVAT || misaInv.TotalAmount || 0,
        nmten: misaInv.AccountObjectName || "",
        nbten: misaInv.CompanyName || "CÔNG TY MISA",
        nbdchi: misaInv.CompanyAddress || "",
        dvtte: misaInv.CurrencyID || "VND",

        // Giữ lại toàn bộ data gốc MISA để tham khảo
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

/**
 * Chuẩn hóa đối tượng hóa đơn thô (từ Thuế hoặc MISA) thành Payload bảng InvoiceRaw của Supabase
 */
async function mapToSupabasePayload(taxData) {
  try {
    const mstNguoiBan = taxData.nbmst || taxData.mstNguoiBan || "";
    const kyHieuHoaDon = taxData.khhdon || taxData.kyHieuHoaDon || "";
    const soHoaDon = taxData.shdon ? taxData.shdon.toString() : (taxData.soHoaDon ? taxData.soHoaDon.toString() : "");

    // 1. Chuỗi băm chống trùng lặp: mstNguoiBan + kyHieuHoaDon + soHoaDon
    const rawInputKey = `${mstNguoiBan}${kyHieuHoaDon}${soHoaDon}`;
    const invoiceUuid = await generateUUIDv5(rawInputKey);

    const isoNow = new Date().toISOString();

    const dataContent = {
      "id": invoiceUuid,
      "soHoaDon": soHoaDon,
      "nguonDuLieu": taxData.misaRawData ? "MISA_MEINVOICE" : "CO_QUAN_THUE",
      "kyHieuHoaDon": kyHieuHoaDon,
      "ngay": formatDateDDMMYYYY(taxData.tdlap),
      "khachHang": taxData.nmten || "",
      "maSoThue": taxData.nmmst || taxData.mstNguoiMua || "",
      "diaChi": taxData.nbdchi || "", 
      "trangThai": "Hóa đơn mới",
      "nguoiBan": taxData.nbten || "",
      "mstNguoiBan": mstNguoiBan,
      "mauSo": "1",
      "donViTienTe": taxData.dvtte || "VND",
      "ketQuaKiemTra": "Đã cấp mã hóa đơn",
      "trangThaiPhatHanh": "Đã cấp mã",
      "items": taxData.items || [],
      "tongTien": taxData.tgtttbso || 0,
      "tongTruocThue": taxData.tgtcthue || 0,
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
// 6. ĐẨY DỮ LIỆU LÊN SUPABASE (CHECK-BEFORE-INSERT WORKFLOW & GUARD CLAUSE)
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

  sendLog(`🔍 Bắt đầu kiểm tra chống trùng lặp từng hóa đơn trong mảng ${payloadArray.length} bản ghi...`, 'process');

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

    try {
      // 1. TRUY VẤN KIỂM TRA TỒN TẠI (GET FILTER JSON COLUMNS)
      const checkUrl = `${invoiceRawEndpoint}?select=id&data->>soHoaDon=eq.${encodeURIComponent(soHoaDon)}&data->>kyHieuHoaDon=eq.${encodeURIComponent(kyHieuHoaDon)}&data->>mstNguoiBan=eq.${encodeURIComponent(mstNguoiBan)}`;

      const checkResponse = await fetch(checkUrl, {
        method: 'GET',
        headers: commonHeaders
      });

      // 🛑 GUARD CLAUSE: NẾU TRUY VẤN GET LỖI (NON-200 OK) -> BỎ QUA HÓA ĐƠN NÀY, KHÔNG ĐƯỢC CHẠY TIẾP XUỐNG POST!
      if (!checkResponse.ok) {
        const errorText = await checkResponse.text();
        sendLog(`⚠️ Lỗi khi tra cứu DB hóa đơn ${soHoaDon}: ${errorText}`, 'error');
        continue;
      }

      const existingRecords = await checkResponse.json();

      if (!Array.isArray(existingRecords)) {
        sendLog(`⚠️ Dữ liệu trả về khi tra cứu hóa đơn ${soHoaDon} không đúng cấu trúc mảng. Bỏ qua!`, 'error');
        continue;
      }

      // 2. XỬ LÝ KẾT QUẢ TRẢ VỀ (CHECK-BEFORE-INSERT)
      if (existingRecords.length > 0) {
        skippedCount++;
        sendLog(`[Bỏ qua] Hóa đơn số ${soHoaDon} (MST: ${mstNguoiBan}) đã có trong hệ thống.`, 'warn');
      } else {
        const insertResponse = await fetch(invoiceRawEndpoint, {
          method: 'POST',
          headers: {
            ...commonHeaders,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!insertResponse.ok) {
          const insertErrText = await insertResponse.text();
          throw new Error(`Lỗi POST thêm mới [${insertResponse.status}]: ${insertErrText}`);
        }

        addedCount++;
        sendLog(`[Thêm mới] Hóa đơn số ${soHoaDon} (MST: ${mstNguoiBan}) đã được lưu.`, 'success');
      }

    } catch (itemError) {
      console.error(`[syncToSupabase] Lỗi xử lý hóa đơn số ${soHoaDon} (MST: ${mstNguoiBan}):`, itemError);
      sendLog(`⚠️ Lỗi xử lý hóa đơn số ${soHoaDon}: ${itemError.message}`, 'error');
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
// 7. CHẠY TOÀN BỘ QUY TRÌNH & ĐIỀU HƯỚNG ROUTING TỪ POPUP / ALARMS
// =========================================================================

/**
 * Điều phối toàn bộ quy trình đồng bộ hóa đơn (Hỗ trợ Routing theo sourceDomain)
 */
async function runFullSyncProcess(startDateStr, endDateStr, syncType = 'MUA_VAO', sourceDomain = '', logCallback = null) {
  const sendLog = (msg, type = 'info') => {
    console.log(`[SyncEngine] ${msg}`);
    if (logCallback) logCallback(msg, type);
  };

  try {
    const typeLabel = syncType === 'BAN_RA' ? 'BÁN RA' : 'MUA VÀO';
    let rawInvoices = [];

    // YÊU CẦU 4: KIỂM TRA VÀ ĐIỀU HƯỚNG CHẠY LUỒNG (ROUTING)
    if (sourceDomain && sourceDomain.includes('meinvoice.vn')) {
      // LUỒNG MISA MEINVOICE
      sendLog(`🚀 Bắt đầu quy trình đồng bộ MISA meInvoice [${typeLabel}] từ ${startDateStr} đến ${endDateStr}...`, 'process');
      rawInvoices = await fetchMisaInvoices(startDateStr, endDateStr, syncType, sendLog);
    } else {
      // LUỒNG TỔNG CỤC THUẾ (MẶC ĐỊNH)
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

    // CẢ 2 LUỒNG ĐỀU CHUẨN HÓA VÀ ĐẨY QUA syncToSupabase
    sendLog(`⏳ Đang khởi tạo mã UUID v5 & chuẩn hóa Payload...`, 'process');
    const payloadArray = [];
    for (const itemData of rawInvoices) {
      const payload = await mapToSupabasePayload(itemData);
      payloadArray.push(payload);
    }

    sendLog(`📤 Đang thực hiện kiểm tra chống trùng lặp & đồng bộ ${payloadArray.length} hóa đơn lên Supabase...`, 'process');
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

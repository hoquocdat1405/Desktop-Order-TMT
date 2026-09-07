import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb } from "pdf-lib";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";

// Khởi tạo CORS Headers để Electron kết nối Cross-Origin
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

// Khởi tạo Supabase Client trỏ riêng tới Project Shopee: Order Processing
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL_SHOPEE || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY_SHOPEE || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_SHOPEE || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Proxy VPS dùng để Refresh Token nhằm vượt rào IP Whitelist
const HOST = "https://partner.shopeemobile.com";
const EXPRESS_CHANNEL_IDS = new Set([50026, 50022, 50031, 50020, 50050]);

const GET_ORDER_DETAIL = "/api/v2/order/get_order_detail";
const MASS_PARAM_PATH = "/api/v2/logistics/get_mass_shipping_parameter";
const MASS_SHIP_PATH = "/api/v2/logistics/mass_ship_order";
const MASS_TRACKING_NUMBER = "/api/v2/logistics/get_mass_tracking_number";
const CREATE_SHIPPING_DOCUMENT = "/api/v2/logistics/create_shipping_document";
const DOCUMENT_RESULT = "/api/v2/logistics/get_shipping_document_result";
const DOWNLOAD_DOCUMENT = "/api/v2/logistics/download_shipping_document";

const CONCURRENCY_LIMIT = 10; // 10 luồng xử lý song song
const BATCH_SIZE = 5;        // Xử lý 5 đơn/batch

let CONFIG = {
  PARTNER_ID: 0,
  PARTNER_KEY: "",
  ACCESS_TOKEN: "",
  SHOP_ID: 0,
};

const STATUS_MAP: Record<string, string> = {
  "PROCESSED": "Chờ lấy hàng",
  "SHIPPED": "Đang giao",
  "TO_CONFIRM_RECEIVE": "Đã giao",
  "DELIVERED": "Đã giao",
  "COMPLETED": "Đã nhận được hàng",
  "UNPAID": "Chờ sắp xếp",
  "READY_TO_SHIP": "Chờ xác nhận",
  "IN_CANCEL": "Chờ xác nhận hủy",
  "RETRY_SHIP": "Tìm lại tài xế",
  "CANCELLED": "Hủy",
  "FAILED": "Thất bại"
};

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  taskFn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await taskFn(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function mapStatusToVn(status: string): string {
  const s = String(status).toUpperCase().trim();
  return STATUS_MAP[s] || status || "Không rõ trạng thái";
}

function isExpressOrder(order: any): boolean {
  for (const pkg of order.package_list || []) {
    if (EXPRESS_CHANNEL_IDS.has(pkg.logistics_channel_id)) return true;
  }
  return false;
}

function wrapText(text: string, maxWidth: number, font: any, fontSize: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * LẤY VÀ AUTO-REFRESH CONFIG SHOPEE TỪ DATABASE "Order Processing"
 */
async function loadConfigFromSupabase(shopId: string): Promise<boolean> {
  console.log("==================== [DEBUG LOAD CONFIG] ====================");
  console.log(`[CONFIG] Received shop_id from Client: "${shopId}"`);
  console.log(`[CONFIG] Supabase URL: "${supabaseUrl}"`);

  if (!shopId) {
    console.error("[CONFIG ERROR] ❌ Lỗi: shop_id bị trống hoặc undefined.");
    return false;
  }

  try {
    // 1. Đọc Token từ DB Order Processing
    console.log(`[CONFIG] 🔍 Querying table 'shop_credentials' where shop_id = '${shopId}'...`);
    const { data: cred, error: credError } = await supabase
      .from("shop_credentials")
      .select("*")
      .eq("shop_id", shopId)
      .maybeSingle();

    if (credError) {
      console.error("[CONFIG ERROR] ❌ Supabase Query Error (shop_credentials):", credError);
      return false;
    }
    if (!cred) {
      console.error(`[CONFIG ERROR] ❌ Record NOT FOUND in 'shop_credentials' for shop_id = '${shopId}'`);
      return false;
    }

    console.log("[CONFIG] ✅ Found 'shop_credentials':", {
      id: cred.id,
      shop_id: cred.shop_id,
      platform_app_id: cred.platform_app_id,
      seller_shop_id: cred.seller_shop_id,
      has_access_token: !!cred.access_token,
      expires_at: cred.access_token_expires_at,
    });

    if (!cred.platform_app_id) {
      console.error("[CONFIG ERROR] ❌ platform_app_id is NULL or empty in 'shop_credentials'.");
      return false;
    }

    // 2. Đọc App Key/Secret của Shopee từ bảng platform_apps
    console.log(`[CONFIG] 🔍 Querying table 'platform_apps' where id = '${cred.platform_app_id}'...`);
    const { data: appData, error: appError } = await supabase
      .from("platform_apps")
      .select("app_key, app_secret")
      .eq("id", cred.platform_app_id)
      .single();

    if (appError) {
      console.error("[CONFIG ERROR] ❌ Supabase Query Error (platform_apps):", appError);
      return false;
    }
    if (!appData) {
      console.error(`[CONFIG ERROR] ❌ Record NOT FOUND in 'platform_apps' for id = '${cred.platform_app_id}'`);
      return false;
    }

    console.log("[CONFIG] ✅ Found 'platform_apps':", {
      app_key: appData.app_key,
      has_app_secret: !!appData.app_secret,
    });

    const partnerId = parseInt(String(appData.app_key || "0").trim(), 10) || 0;
    const partnerKey = String(appData.app_secret || "").trim();
    const sellerShopId = parseInt(String(cred.seller_shop_id || "0").trim(), 10) || 0;
    let accessToken = cred.access_token || "";

    console.log(`[CONFIG Parsed] PartnerID=${partnerId}, SellerShopID=${sellerShopId}, PartnerKeyLength=${partnerKey.length}`);

    if (!partnerId || !partnerKey || !sellerShopId) {
      console.error("[CONFIG ERROR] ❌ Field validation failed: One of PartnerID, PartnerKey, or SellerShopID is invalid/0.");
      return false;
    }

    const now = new Date();
    const expiresAt = cred.access_token_expires_at ? new Date(cred.access_token_expires_at) : new Date(0);

    // 3. Tự động Refresh Token nếu Token hết hạn (hoặc còn dưới 10 phút)
    if (expiresAt.getTime() - now.getTime() < 10 * 60 * 1000) {
      console.log("[CONFIG] 🔄 Access token sắp/đã hết hạn. Tiến hành Refresh Token...");
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const refreshPath = "/api/v2/auth/access_token/get";
        const baseString = `${partnerId}${refreshPath}${timestamp}`;
        
        const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
        const url = `${HOST}${refreshPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh_token: cred.refresh_token,
            shop_id: sellerShopId,
            partner_id: partnerId,
          }),
        });

        const refreshData = await res.json();
        console.log("[CONFIG Refresh Response]:", refreshData);

        if (refreshData.access_token) {
          accessToken = refreshData.access_token;
          const expiresInSeconds = refreshData.expire_in || 14400;
          const newExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

          await supabase
            .from("shop_credentials")
            .update({
              access_token: refreshData.access_token,
              refresh_token: refreshData.refresh_token || cred.refresh_token,
              access_token_expires_at: newExpiresAt,
              updated_at: new Date().toISOString(),
            })
            .eq("shop_id", shopId);

          console.log("[CONFIG] ✅ Đã cập nhật Token mới vào Database thành công!");
        } else {
          console.error("[CONFIG ERROR] ❌ Refresh Token bị từ chối từ phía Shopee:", refreshData);
        }
      } catch (refreshErr) {
        console.error("[CONFIG ERROR] ❌ Lỗi ngoại lệ khi Refresh Token:", refreshErr);
      }
    }

    CONFIG = {
      PARTNER_ID: partnerId,
      PARTNER_KEY: partnerKey,
      ACCESS_TOKEN: accessToken,
      SHOP_ID: sellerShopId,
    };

    console.log("[CONFIG SUCCESS] ✅ Nạp cấu hình thành công!");
    console.log("============================================================");
    return CONFIG.PARTNER_ID > 0 && !!CONFIG.PARTNER_KEY && !!CONFIG.ACCESS_TOKEN;
  } catch (e) {
    console.error("[CONFIG EXCEPTION] ❌ Exception in loadConfigFromSupabase:", e);
    return false;
  }
}

function generateShopeeSign(pathUri: string, timestamp: number): string {
  const baseStr = `${CONFIG.PARTNER_ID}${pathUri}${timestamp}${CONFIG.ACCESS_TOKEN}${CONFIG.SHOP_ID}`;
  return crypto.createHmac("sha256", CONFIG.PARTNER_KEY).update(baseStr).digest("hex");
}

async function getOrderDetailsBatch(orderSnList: string[]): Promise<any[]> {
  if (orderSnList.length === 0) return [];
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(GET_ORDER_DETAIL, timestamp);

  const queryParams = new URLSearchParams({
    partner_id: CONFIG.PARTNER_ID.toString(),
    timestamp: timestamp.toString(),
    access_token: CONFIG.ACCESS_TOKEN,
    shop_id: CONFIG.SHOP_ID.toString(),
    sign: sign,
    order_sn_list: orderSnList.join(","),
    response_optional_fields: "order_status,total_amount,package_list,item_list",
    request_order_status_pending: "false",
  }).toString();

  try {
    console.log(`[Shopee API] 📤 get_order_detail:`, orderSnList);
    const response = await fetch(`${HOST}${GET_ORDER_DETAIL}?${queryParams}`, { method: "GET" });
    const result = await response.json();
    
    if (result.error) {
      console.error(`[Shopee API Error] get_order_detail:`, result);
    } else {
      console.log(`[Shopee API Response] Lấy chi tiết thành công cho ${result.response?.order_list?.length || 0} đơn.`);
    }

    return result.response?.order_list || [];
  } catch (err) {
    console.error("[Shopee API Exception] get_order_detail:", err);
    return [];
  }
}

async function getMassShippingParameter(packageNumbers: string[]): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(MASS_PARAM_PATH, timestamp);

  const queryParams = new URLSearchParams({
    partner_id: CONFIG.PARTNER_ID.toString(),
    timestamp: timestamp.toString(),
    access_token: CONFIG.ACCESS_TOKEN,
    shop_id: CONFIG.SHOP_ID.toString(),
    sign: sign,
  }).toString();

  try {
    console.log(`[Shopee API] 📤 get_mass_shipping_parameter cho packages:`, packageNumbers);
    const response = await fetch(`${HOST}${MASS_PARAM_PATH}?${queryParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_list: packageNumbers.map(p => ({ package_number: p })) }),
    });
    return await response.json();
  } catch (err) {
    console.error("[Shopee API Exception] get_mass_shipping_parameter:", err);
    return null;
  }
}

async function massShipOrder(massParamData: any, packageNumbers: string[]): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(MASS_SHIP_PATH, timestamp);

  const pickup = massParamData?.response?.pickup || {};
  const addressList = pickup.address_list || [];
  let addressId = null;
  let pickupTimeId = null;

  if (addressList.length > 0) {
    const a = addressList[0];
    addressId = a.address_id;
    const tsl = a.time_slot_list || [];
    if (tsl.length > 0) pickupTimeId = tsl[0].pickup_time_id;
  }

  const queryParams = new URLSearchParams({
    partner_id: CONFIG.PARTNER_ID.toString(),
    timestamp: timestamp.toString(),
    access_token: CONFIG.ACCESS_TOKEN,
    shop_id: CONFIG.SHOP_ID.toString(),
    sign: sign,
  }).toString();

  const body = {
    package_list: packageNumbers.map(p => ({ package_number: p })),
    pickup: { address_id: addressId, pickup_time_id: pickupTimeId }
  };

  try {
    console.log(`[Shopee API] 📤 mass_ship_order với Body:`, body);
    const response = await fetch(`${HOST}${MASS_SHIP_PATH}?${queryParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    console.log(`[Shopee API Response] mass_ship_order:`, result);
    return result;
  } catch (err) {
    console.error("[Shopee API Exception] mass_ship_order:", err);
    return null;
  }
}

async function getMassTrackingNumbers(packageNumbers: string[], retry = 3): Promise<any[]> {
  const pathUri = MASS_TRACKING_NUMBER;

  for (let attempt = 1; attempt <= retry; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(pathUri, timestamp);

    const queryParams = new URLSearchParams({
      partner_id: CONFIG.PARTNER_ID.toString(),
      timestamp: timestamp.toString(),
      access_token: CONFIG.ACCESS_TOKEN,
      shop_id: CONFIG.SHOP_ID.toString(),
      sign: sign,
    }).toString();

    const body = {
      package_list: packageNumbers.map(p => ({ package_number: p })),
      response_optional_fields: "tracking_number,first_mile_tracking_number,sls_tracking_number,logistics_tracking_number",
    };

    try {
      console.log(`[Shopee API] 📤 get_mass_tracking_number (Lần ${attempt}) cho:`, packageNumbers);
      const response = await fetch(`${HOST}${pathUri}?${queryParams}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resData = await response.json();
      const successList = resData.response?.success_list || [];
      if (successList.length > 0) {
        console.log(`Lấy mã vận đơn thành công:`, successList.length);
        return successList.map((s: any) => ({
          package_number: s.package_number,
          tracking_number: s.tracking_number || s.sls_tracking_number || s.logistics_tracking_number || s.first_mile_tracking_number
        }));
      }
    } catch (err) {
      console.error(`Lỗi get_mass_tracking_number lần ${attempt}:`, err);
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  return [];
}

async function createShippingDocumentExpress(orderList: any[]): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(CREATE_SHIPPING_DOCUMENT, timestamp);

  const queryParams = new URLSearchParams({
    partner_id: CONFIG.PARTNER_ID.toString(),
    timestamp: timestamp.toString(),
    access_token: CONFIG.ACCESS_TOKEN,
    shop_id: CONFIG.SHOP_ID.toString(),
    sign: sign,
  }).toString();

  const bodyList = orderList.map(o => {
    const item: any = { order_sn: o.order_sn, shipping_document_type: "NORMAL_AIR_WAYBILL" };
    if (o.package_number) item.package_number = o.package_number;
    return item;
  });

  try {
    console.log(`[Shopee API] 📤 create_shipping_document (Express)`);
    const response = await fetch(`${HOST}${CREATE_SHIPPING_DOCUMENT}?${queryParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_list: bodyList }),
    });
    const data = await response.json();
    return !(data.response?.fail_list && data.response.fail_list.length > 0);
  } catch (err) {
    return false;
  }
}

async function createShippingDocumentNormal(trackingList: any[]): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(CREATE_SHIPPING_DOCUMENT, timestamp);

  const orderList = trackingList
    .filter(t => t.order_sn && t.package_number && t.tracking_number)
    .map(t => ({
      order_sn: t.order_sn,
      package_number: t.package_number,
      tracking_number: t.tracking_number,
      shipping_document_type: "NORMAL_AIR_WAYBILL"
    }));

  if (orderList.length === 0) return false;

  const queryParams = new URLSearchParams({
    partner_id: CONFIG.PARTNER_ID.toString(),
    timestamp: timestamp.toString(),
    access_token: CONFIG.ACCESS_TOKEN,
    shop_id: CONFIG.SHOP_ID.toString(),
    sign: sign,
  }).toString();

  try {
    console.log(`[Shopee API] 📤 create_shipping_document (Normal)`);
    const response = await fetch(`${HOST}${CREATE_SHIPPING_DOCUMENT}?${queryParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_list: orderList }),
    });
    const data = await response.json();
    return !(data.response?.fail_list && data.response.fail_list.length > 0);
  } catch (err) {
    return false;
  }
}

async function poolShippingDocumentResult(orderList: any[], timeout = 15): Promise<boolean> {
  const start = Date.now();
  console.log(`🔄 Bắt đầu Polling trạng thái PDF (timeout ${timeout}s)...`);
  while ((Date.now() - start) / 1000 < timeout) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(DOCUMENT_RESULT, timestamp);

    const queryParams = new URLSearchParams({
      partner_id: CONFIG.PARTNER_ID.toString(),
      timestamp: timestamp.toString(),
      access_token: CONFIG.ACCESS_TOKEN,
      shop_id: CONFIG.SHOP_ID.toString(),
      sign: sign,
    }).toString();

    try {
      const response = await fetch(`${HOST}${DOCUMENT_RESULT}?${queryParams}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_list: orderList }),
      });
      const data = await response.json();
      const resultList = data?.response?.result_list || [];

      if (resultList.some((r: any) => r.fail_error)) {
        console.error(`❌ Lỗi khi poll PDF result:`, resultList);
        return false;
      }

      const statuses = resultList.map((r: any) => r.status);
      if (statuses.length > 0 && statuses.every((s: string) => s === "READY")) {
        console.log(`✅ File PDF đã READY trên Shopee!`);
        return true;
      }
    } catch (e) {}
    await new Promise((res) => setTimeout(res, 300));
  }
  console.warn(`⚠️ Polling PDF result hết thời gian timeout (${timeout}s).`);
  return false;
}

async function downloadShippingDocumentBytes(trackingList: any[], maxRetry = 3): Promise<ArrayBuffer | null> {
  const orderList = trackingList.map(t => {
    const item: any = { order_sn: t.order_sn };
    if (t.package_number) item.package_number = t.package_number;
    return item;
  });

  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(DOWNLOAD_DOCUMENT, timestamp);

    const queryParams = new URLSearchParams({
      partner_id: CONFIG.PARTNER_ID.toString(),
      timestamp: timestamp.toString(),
      access_token: CONFIG.ACCESS_TOKEN,
      shop_id: CONFIG.SHOP_ID.toString(),
      sign: sign,
    }).toString();

    try {
      console.log(`[Shopee API] 📤 download_shipping_document (Lần ${attempt})...`);
      const response = await fetch(`${HOST}${DOWNLOAD_DOCUMENT}?${queryParams}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipping_document_type: "NORMAL_AIR_WAYBILL",
          order_list: orderList,
        }),
      });

      if (response.ok && response.headers.get("content-type")?.includes("application/pdf")) {
        console.log(`📥 Tải PDF thành công từ Shopee!`);
        return await response.arrayBuffer();
      } else {
        const errText = await response.text();
        console.error(`❌ Tải PDF thất bại (lần ${attempt}):`, errText);

        if (errText.includes("shipping_document_should_print_first")) {
          console.log("🖨️ Shopee yêu cầu tạo lại Document, tiến hành kích hoạt lại...");
          const expressSimple = trackingList.filter(t => t.is_express);
          const normalTracking = trackingList.filter(t => !t.is_express);

          if (expressSimple.length > 0) await createShippingDocumentExpress(expressSimple);
          if (normalTracking.length > 0) await createShippingDocumentNormal(normalTracking);

          await new Promise((res) => setTimeout(res, 300));
        }
      }
    } catch (err) {
      console.error("[Shopee API Exception] download_shipping_document:", err);
    }
  }

  return null;
}

async function extractSingleLabel(srcDoc: PDFDocument, orderIndexInBatch: number): Promise<PDFDocument> {
  const singleDoc = await PDFDocument.create();
  const sourcePageIndex = Math.floor(orderIndexInBatch / 4);
  const quadrantIndex = orderIndexInBatch % 4;

  if (sourcePageIndex >= srcDoc.getPageCount()) return singleDoc;

  const [copiedPage] = await singleDoc.copyPages(srcDoc, [sourcePageIndex]);
  const { width, height } = copiedPage.getSize();
  const singleW = width / 2;
  const singleH = height / 2;

  const quads = [
    { x: 0, y: -singleH },         // Top-Left
    { x: 0, y: 0 },                // Bottom-Left
    { x: -singleW, y: -singleH },  // Top-Right
    { x: -singleW, y: 0 },         // Bottom-Right
  ];

  const quad = quads[quadrantIndex];
  const embedded = await singleDoc.embedPage(copiedPage);
  
  const newPage = singleDoc.addPage([singleW, singleH]);
  newPage.drawPage(embedded, {
    x: quad.x,
    y: quad.y,
    width: width,
    height: height,
  });

  return singleDoc;
}

async function appendPickingSlipToDoc(targetDoc: PDFDocument, groupName: string, ordersData: any[], fontBytes: Buffer, productDbMap: Record<string, string>) {
  targetDoc.registerFontkit(fontkit);
  const fontVn = await targetDoc.embedFont(fontBytes);

  let page = targetDoc.addPage([419.53, 595.27]);
  const pageWidth = 419.53;

  function drawPageHeader(p: any, isFirstPage: boolean) {
    if (!isFirstPage) return 560;
    const titleText = `PHIẾU XUẤT KHO (SHOPEE) – ${groupName}`;
    p.drawText(titleText, { x: (pageWidth - fontVn.widthOfTextAtSize(titleText, 12)) / 2, y: 570, size: 12, font: fontVn });
    const timeStr = `Thời gian: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`;
    p.drawText(timeStr, { x: (pageWidth - fontVn.widthOfTextAtSize(timeStr, 9)) / 2, y: 555, size: 9, font: fontVn });
    const totalText = `TỔNG ĐƠN HÀNG: ${ordersData.length}`;
    p.drawText(totalText, { x: (pageWidth - fontVn.widthOfTextAtSize(totalText, 9)) / 2, y: 542, size: 9, font: fontVn });
    return 525;
  }

  let yY = drawPageHeader(page, true);
  const tableX = 15;
  const tableWidth = 390;
  const colWidths = { stt: 25, maDon: 105, sku: 65, tenSp: 160, sl: 35 };
  const headerHeight = 16;

  function drawDetailTableHeader(p: any, targetY: number) {
    p.drawRectangle({ x: tableX, y: targetY - headerHeight, width: tableWidth, height: headerHeight, color: rgb(0.92, 0.94, 0.96), borderWidth: 0.5, borderColor: rgb(0.7, 0.74, 0.8) });
    const headers = [
      { text: "STT", x: tableX + colWidths.stt / 2, center: true },
      { text: "MÃ ĐƠN", x: tableX + colWidths.stt + colWidths.maDon / 2, center: true },
      { text: "SKU", x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku / 2, center: true },
      { text: "TÊN SẢN PHẨM", x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp / 2, center: true },
      { text: "SL", x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp + colWidths.sl / 2, center: true },
    ];
    headers.forEach((h) => {
      p.drawText(h.text, { x: h.center ? h.x - fontVn.widthOfTextAtSize(h.text, 7.5) / 2 : h.x, y: targetY - headerHeight + (headerHeight - 7.5) / 2, size: 7.5, font: fontVn });
    });
  }

  drawDetailTableHeader(page, yY);
  yY -= headerHeight;

  let sttIdx = 1;
  const skuCounterMap: Record<string, { name: string; qty: number }> = {};

  for (const order of ordersData) {
    const orderSn = order.order_sn;
    const items = order.item_list || [];
    const mergedSingleOrder: Record<string, { name: string; qty: number }> = {};

    for (const it of items) {
      const rawSku = (it.model_sku || it.item_sku || "UNKNOWN").trim();
      if (rawSku.toLowerCase().startsWith("codeao")) continue;

      const shopeeName = it.model_name ? `${it.item_name} - ${it.model_name}` : it.item_name;
      const baseQty = parseInt(it.model_quantity_purchased || "1", 10);
      const skuParts = rawSku.split("+").map((s: string) => s.trim()).filter(Boolean);

      for (const part of skuParts) {
        let sku = part;
        let mul = 1;
        if (part.includes("*")) {
          const [skuCode, mulStr] = part.split("*");
          sku = skuCode.trim();
          mul = parseInt(mulStr, 10) || 1;
        }
        const calculatedQty = baseQty * mul;
        const finalDisplayName = productDbMap[sku] || shopeeName;

        mergedSingleOrder[sku] = {
          name: finalDisplayName,
          qty: (mergedSingleOrder[sku]?.qty || 0) + calculatedQty,
        };
      }
    }

    let isFirstRowOfOrder = true;
    for (const sku of Object.keys(mergedSingleOrder)) {
      const itemData = mergedSingleOrder[sku];
      const wrappedLines = wrapText(itemData.name, 150, fontVn, 6.5);
      const rowHeight = Math.max(18, wrappedLines.length * 9 + 6);

      if (yY - rowHeight < 40) {
        page = targetDoc.addPage([419.53, 595.27]);
        const nextY = drawPageHeader(page, false);
        drawDetailTableHeader(page, nextY);
        yY = nextY - headerHeight;
      }

      skuCounterMap[sku] = {
        name: itemData.name,
        qty: (skuCounterMap[sku]?.qty || 0) + itemData.qty,
      };

      let curX = tableX;
      [colWidths.stt, colWidths.maDon, colWidths.sku, colWidths.tenSp, colWidths.sl].forEach((w) => {
        page.drawRectangle({ x: curX, y: yY - rowHeight, width: w, height: rowHeight, borderWidth: 0.5, borderColor: rgb(0.8, 0.82, 0.85) });
        curX += w;
      });

      const centerY = yY - rowHeight + (rowHeight - 6.5) / 2;

      if (isFirstRowOfOrder) {
        page.drawText(String(sttIdx++), { x: tableX + (colWidths.stt - fontVn.widthOfTextAtSize(String(sttIdx - 1), 6.5)) / 2, y: centerY, size: 6.5, font: fontVn });
        page.drawText(orderSn, { x: tableX + colWidths.stt + 5, y: centerY, size: 6.5, font: fontVn });
        isFirstRowOfOrder = false;
      } else {
        page.drawRectangle({ x: tableX, y: yY - rowHeight, width: colWidths.stt + colWidths.maDon, height: rowHeight, color: rgb(0.96, 0.96, 0.96), borderWidth: 0.5, borderColor: rgb(0.8, 0.82, 0.85) });
      }

      page.drawText(sku.substring(0, 15), { x: tableX + colWidths.stt + colWidths.maDon + 5, y: centerY, size: 6.5, font: fontVn });
      
      wrappedLines.forEach((line, lineIdx) => {
        page.drawText(line, { x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + 5, y: yY - 12 - lineIdx * 9, size: 6.5, font: fontVn });
      });

      page.drawText(String(itemData.qty), { x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp + (colWidths.sl - fontVn.widthOfTextAtSize(String(itemData.qty), 6.5)) / 2, y: centerY, size: 6.5, font: fontVn });
      yY -= rowHeight;
    }
  }

  yY -= 25;
  if (yY - 40 < 30) {
    page = targetDoc.addPage([419.53, 595.27]);
    yY = 560;
  }

  const summaryTitle = "BẢNG TỔNG SẢN PHẨM";
  page.drawText(summaryTitle, { x: (pageWidth - fontVn.widthOfTextAtSize(summaryTitle, 10)) / 2, y: yY, size: 10, font: fontVn });
  yY -= 15;

  const sumColWidths = { stt: 25, sku: 105, tenSp: 225, sl: 35 };

  function drawSummaryTableHeader(p: any, targetY: number) {
    p.drawRectangle({ x: tableX, y: targetY - headerHeight, width: tableWidth, height: headerHeight, color: rgb(0.92, 0.94, 0.96), borderWidth: 0.5, borderColor: rgb(0.7, 0.74, 0.8) });
    const sumHeaders = [
      { text: "STT", x: tableX + sumColWidths.stt / 2, center: true },
      { text: "SKU", x: tableX + sumColWidths.stt + sumColWidths.sku / 2, center: true },
      { text: "TÊN SẢN PHẨM", x: tableX + sumColWidths.stt + sumColWidths.sku + sumColWidths.tenSp / 2, center: true },
      { text: "SL", x: tableX + sumColWidths.stt + sumColWidths.sku + sumColWidths.tenSp + sumColWidths.sl / 2, center: true },
    ];
    sumHeaders.forEach((h) => {
      p.drawText(h.text, { x: h.center ? h.x - fontVn.widthOfTextAtSize(h.text, 7.5) / 2 : h.x, y: targetY - headerHeight + (headerHeight - 7.5) / 2, size: 7.5, font: fontVn });
    });
  }

  drawSummaryTableHeader(page, yY);
  yY -= headerHeight;

  let sumSttIdx = 1;
  for (const sku of Object.keys(skuCounterMap).sort()) {
    const sumItem = skuCounterMap[sku];
    const wrappedSumLines = wrapText(sumItem.name, 215, fontVn, 6.5);
    const sumRowHeight = Math.max(18, wrappedSumLines.length * 9 + 6);

    if (yY - sumRowHeight < 30) {
      page = targetDoc.addPage([419.53, 595.27]);
      drawSummaryTableHeader(page, 560);
      yY = 560 - headerHeight;
    }

    let curSumX = tableX;
    [sumColWidths.stt, sumColWidths.sku, sumColWidths.tenSp, sumColWidths.sl].forEach((w) => {
      page.drawRectangle({ x: curSumX, y: yY - sumRowHeight, width: w, height: sumRowHeight, borderWidth: 0.5, borderColor: rgb(0.8, 0.82, 0.85) });
      curSumX += w;
    });

    const sumCenterY = yY - sumRowHeight + (sumRowHeight - 6.5) / 2;

    page.drawText(String(sumSttIdx++), { x: tableX + (sumColWidths.stt - fontVn.widthOfTextAtSize(String(sumSttIdx - 1), 6.5)) / 2, y: sumCenterY, size: 6.5, font: fontVn });
    page.drawText(sku, { x: tableX + sumColWidths.stt + 5, y: sumCenterY, size: 6.5, font: fontVn });
    page.drawText(String(sumItem.qty), { x: tableX + sumColWidths.stt + sumColWidths.sku + sumColWidths.tenSp + (sumColWidths.sl - fontVn.widthOfTextAtSize(String(sumItem.qty), 7)) / 2, y: sumCenterY, size: 7, font: fontVn });
    
    wrappedSumLines.forEach((line, lineIdx) => {
      page.drawText(line, { x: tableX + sumColWidths.stt + sumColWidths.sku + 5, y: yY - 12 - lineIdx * 9, size: 6.5, font: fontVn });
    });

    yY -= sumRowHeight;
  }
}

// MAIN ROUTE HANDLER (POST METHOD)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, shop_id, selected_groups_data, order_ids } = body;

    console.log(`🚀 Request POST: Action='${action}', ShopID='${shop_id}'`);

    const isConfigLoaded = await loadConfigFromSupabase(shop_id);
    if (!isConfigLoaded) {
      console.error("❌ Failed to load config from Supabase for shop_id:", shop_id);
      return NextResponse.json(
        { success: false, message: "Không lấy được cấu hình API từ Supabase (xem Log Terminal)" },
        { status: 400, headers: corsHeaders }
      );
    }

    // ACTION 1: CONFIRM (XÁC NHẬN ĐƠN HÀNG)
    if (action === "confirm") {
      const targetOrderIds: string[] = order_ids || [];
      const orderChunks = chunkArray(targetOrderIds, BATCH_SIZE);

      let totalSuccessCount = 0;
      const failedDetails: { order_id: string; reason: string }[] = [];

      await runWithConcurrencyLimit(orderChunks, CONCURRENCY_LIMIT, async (chunkIds) => {
        const orderListDetail = await getOrderDetailsBatch(chunkIds);

        const fetchedSns = new Set(orderListDetail.map((o: any) => o.order_sn));
        chunkIds.forEach((id: string) => {
          if (!fetchedSns.has(id)) {
            console.warn(`⚠️ Mã đơn ${id} không tìm thấy trên Shopee!`);
            failedDetails.push({ order_id: id, reason: "Không tìm thấy mã đơn" });
          }
        });

        const readyOrders = orderListDetail.filter(o => o.order_status === "READY_TO_SHIP");

        orderListDetail.forEach(o => {
          if (o.order_status !== "READY_TO_SHIP") {
            console.warn(`⚠️ Mã đơn ${o.order_sn} trạng thái không hợp lệ: ${o.order_status}`);
            failedDetails.push({
              order_id: o.order_sn,
              reason: mapStatusToVn(o.order_status)
            });
          }
        });

        if (readyOrders.length > 0) {
          const pkgNumbers = readyOrders.flatMap(o => {
            if (o.package_number) return [o.package_number];
            return (o.package_list || []).map((p: any) => p.package_number);
          }).filter(Boolean);

          if (pkgNumbers.length > 0) {
            const massParam = await getMassShippingParameter(pkgNumbers);
            const massShipRes = await massShipOrder(massParam, pkgNumbers);

            const failList = massShipRes?.response?.fail_list || [];
            if (failList.length > 0) {
              failList.forEach((f: any) => {
                failedDetails.push({
                  order_id: f.order_sn,
                  reason: f.fail_error || "Lỗi xác nhận từ Shopee"
                });
              });
              totalSuccessCount += (readyOrders.length - failList.length);
            } else {
              totalSuccessCount += readyOrders.length;
            }
          }
        }
      });

      console.log(`✅ [CONFIRM] Thành công: ${totalSuccessCount}, Thất bại: ${failedDetails.length}`);

      return NextResponse.json(
        {
          success: true,
          success_count: totalSuccessCount,
          failed_count: failedDetails.length,
          failed_details: failedDetails
        },
        { headers: corsHeaders }
      );
    }

    // ACTION 2: PRINT (IN HÀNG LOẠT)
    if (action === "print") {
      console.log(`🖨️ [PRINT] Đang xử lý các nhóm:`, selected_groups_data?.map((g: any) => g.group_name));

      let fontBytes: Buffer;
      try {
        fontBytes = fs.readFileSync(path.join(process.cwd(), "public", "DejaVuSans.ttf"));
      } catch (e) {
        console.error("❌ Lỗi thiếu tệp font public/DejaVuSans.ttf!");
        return NextResponse.json(
          { success: false, message: "Thiếu tệp public/DejaVuSans.ttf" },
          { status: 500, headers: corsHeaders }
        );
      }

      const resultsPayload: any[] = [];
      let globalSuccessCount = 0;

      for (const group of selected_groups_data) {
        const gName = group.group_name;
        const oIds: string[] = group.order_ids;

        console.log(`🔹 Đang xử lý Nhóm ${gName} (${oIds.length} đơn)...`);

        const chunks = chunkArray(oIds, BATCH_SIZE);
        const groupFailedDetails: any[] = [];
        const groupAllPrintableOrders: any[] = [];
        const groupLabelBatches: { rawBuf: ArrayBuffer; orderCount: number }[] = [];

        const chunkResults = await runWithConcurrencyLimit(chunks, CONCURRENCY_LIMIT, async (chunkOrderIds) => {
          const orderListDetail = await getOrderDetailsBatch(chunkOrderIds);
          const chunkFailedDetails: any[] = [];

          const fetchedSns = new Set(orderListDetail.map((o: any) => o.order_sn));
          chunkOrderIds.forEach((id: string) => {
            if (!fetchedSns.has(id)) {
              console.warn(`⚠️ [PRINT] Đơn ${id} không tìm thấy trên Shopee!`);
              chunkFailedDetails.push({ order_id: id, reason: "Không tìm thấy mã đơn" });
            }
          });

          const expressOrders: any[] = [];
          const normalOrders: any[] = [];

          for (const o of orderListDetail) {
            const status = o.order_status;
            const isExpress = isExpressOrder(o);

            if (isExpress) {
              if (status === "READY_TO_SHIP" || status === "PROCESSED") {
                expressOrders.push(o);
              } else {
                chunkFailedDetails.push({ order_id: o.order_sn, reason: mapStatusToVn(status) });
              }
            } else {
              if (status === "PROCESSED") {
                normalOrders.push(o);
              } else {
                chunkFailedDetails.push({ order_id: o.order_sn, reason: mapStatusToVn(status) });
              }
            }
          }

          const trackingInfo: any[] = [];

          if (normalOrders.length > 0) {
            const normalPkgs = normalOrders.flatMap(o => {
              if (o.package_number) return [o.package_number];
              return (o.package_list || []).map((p: any) => p.package_number);
            }).filter(Boolean);

            const trackingResults = await getMassTrackingNumbers(normalPkgs);

            for (const t of trackingResults) {
              const matchedOrder = normalOrders.find(o => 
                o.package_number === t.package_number || 
                (o.package_list || []).some((p: any) => p.package_number === t.package_number)
              );
              if (matchedOrder && t.tracking_number) {
                trackingInfo.push({
                  order_sn: matchedOrder.order_sn,
                  package_number: t.package_number,
                  tracking_number: t.tracking_number,
                  is_express: false
                });
              }
            }

            normalOrders.forEach(o => {
              if (!trackingInfo.some(t => t.order_sn === o.order_sn)) {
                chunkFailedDetails.push({ order_id: o.order_sn, reason: "Lỗi Shopee: Chưa cấp mã vận đơn" });
              }
            });
          }

          for (const o of expressOrders) {
            const pkgs = o.package_list || [];
            if (pkgs.length > 0) {
              pkgs.forEach((p: any) => {
                trackingInfo.push({ order_sn: o.order_sn, package_number: p.package_number, tracking_number: null, is_express: true });
              });
            } else {
              trackingInfo.push({ order_sn: o.order_sn, package_number: o.package_number || null, tracking_number: null, is_express: true });
            }
          }

          if (trackingInfo.length === 0) {
            return { failedDetails: chunkFailedDetails, printableOrders: [], rawLabelBytes: null, validOrderCount: 0 };
          }

          const expressSimple = trackingInfo.filter(t => t.is_express);
          const normalTracking = trackingInfo.filter(t => !t.is_express);

          if (expressSimple.length > 0) {
            await createShippingDocumentExpress(expressSimple);
          }
          if (normalTracking.length > 0) {
            await createShippingDocumentNormal(normalTracking);
          }

          const docOrderList = trackingInfo.map(t => {
            const item: any = { order_sn: t.order_sn, shipping_document_type: "NORMAL_AIR_WAYBILL" };
            if (t.package_number) item.package_number = t.package_number;
            return item;
          });

          const isReady = await poolShippingDocumentResult(docOrderList);
          let rawLabelBytes: ArrayBuffer | null = null;
          let printableOrders: any[] = [];

          if (isReady) {
            rawLabelBytes = await downloadShippingDocumentBytes(trackingInfo);
            if (rawLabelBytes) {
              const printableSns = new Set(trackingInfo.map(t => t.order_sn));
              printableOrders = orderListDetail.filter(o => printableSns.has(o.order_sn));
            }
          }

          return {
            failedDetails: chunkFailedDetails,
            printableOrders,
            rawLabelBytes,
            validOrderCount: docOrderList.length
          };
        });

        for (const res of chunkResults) {
          groupFailedDetails.push(...res.failedDetails);
          groupAllPrintableOrders.push(...res.printableOrders);
          if (res.rawLabelBytes && res.validOrderCount > 0) {
            groupLabelBatches.push({ rawBuf: res.rawLabelBytes, orderCount: res.validOrderCount });
          }
        }

        let pdfBase64 = "";
        let groupSuccessCount = 0;

        if (groupLabelBatches.length > 0) {
          console.log(`📑 Ghép PDF cho Nhóm ${gName}...`);
          const allSkusInOrders = new Set<string>();
          for (const order of groupAllPrintableOrders) {
            for (const it of order.item_list || []) {
              const rawSku = (it.model_sku || it.item_sku || "UNKNOWN").trim();
              if (rawSku.toLowerCase().startsWith("codeao")) continue;
              const skuParts = rawSku.split("+").map((s: string) => s.trim()).filter(Boolean);
              for (const part of skuParts) {
                let sku = part.includes("*") ? part.split("*")[0].trim() : part;
                allSkusInOrders.add(sku);
              }
            }
          }

          const productDbMap: Record<string, string> = {};
          if (allSkusInOrders.size > 0) {
            const { data: dbProducts } = await supabase
              .from("products")
              .select("sku, standard_name")
              .in("sku", Array.from(allSkusInOrders));
            
            dbProducts?.forEach(p => { 
              if (p.sku && p.standard_name) productDbMap[p.sku.trim()] = p.standard_name.trim(); 
            });
          }

          const allSingleLabelDocs: PDFDocument[] = [];

          for (const batch of groupLabelBatches) {
            const srcDoc = await PDFDocument.load(batch.rawBuf);
            const extractPromises = [];
            for (let orderIdx = 0; orderIdx < batch.orderCount; orderIdx++) {
              extractPromises.push(extractSingleLabel(srcDoc, orderIdx));
            }
            const singleDocs = await Promise.all(extractPromises);
            for (const doc of singleDocs) {
              if (doc.getPageCount() > 0) {
                allSingleLabelDocs.push(doc);
              }
            }
          }

          const finalPdf = await PDFDocument.create();
          finalPdf.registerFontkit(fontkit);
          const fontVn = await finalPdf.embedFont(fontBytes);

          const totalLabels = allSingleLabelDocs.length;
          const halfCount = Math.ceil(totalLabels / 2);

          for (let i = 0; i < halfCount; i++) {
            const leftDoc = allSingleLabelDocs[i];
            const rightDoc = (i + halfCount < totalLabels) ? allSingleLabelDocs[i + halfCount] : null;

            const [leftPage] = await finalPdf.copyPages(leftDoc, [0]);
            const { width: sW, height: sH } = leftPage.getSize();

            const combinedPage = finalPdf.addPage([sW * 2, sH]);

            const embeddedLeft = await finalPdf.embedPage(leftPage);
            await combinedPage.drawPage(embeddedLeft, { x: 0, y: 0, width: sW, height: sH });
            await combinedPage.drawText(`${gName}-${i + 1}`, {
              x: 100,
              y: sH - 20,
              size: 11,
              font: fontVn,
              color: rgb(1, 0, 0),
            });

            if (rightDoc) {
              const [rightPage] = await finalPdf.copyPages(rightDoc, [0]);
              const embeddedRight = await finalPdf.embedPage(rightPage);
              await combinedPage.drawPage(embeddedRight, { x: sW, y: 0, width: sW, height: sH });
              await combinedPage.drawText(`${gName}-${i + 1 + halfCount}`, {
                x: sW + 100,
                y: sH - 20,
                size: 11,
                font: fontVn,
                color: rgb(1, 0, 0),
              });
            }
          }

          await appendPickingSlipToDoc(finalPdf, gName, groupAllPrintableOrders, fontBytes, productDbMap);

          const finalPdfBuffer = await finalPdf.save();
          pdfBase64 = Buffer.from(finalPdfBuffer).toString("base64");
          groupSuccessCount = totalLabels;
          globalSuccessCount += groupSuccessCount;
        }

        resultsPayload.push({
          group_name: gName,
          success_count: groupSuccessCount,
          pdf_base64: pdfBase64,
          failed_details: groupFailedDetails
        });
      }

      console.log(`✅ [PRINT HOÀN TẤT] Tổng đơn tạo PDF thành công: ${globalSuccessCount}`);

      return NextResponse.json(
        {
          success: true,
          total_success_orders: globalSuccessCount,
          files: resultsPayload
        },
        { headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: false, message: "Action không hợp lệ" },
      { status: 400, headers: corsHeaders }
    );

  } catch (error: any) {
    console.error("❌ Lỗi Route Handler Server:", error);
    return NextResponse.json(
      { success: false, message: error.message || "Lỗi server" },
      { status: 500, headers: corsHeaders }
    );
  }
}
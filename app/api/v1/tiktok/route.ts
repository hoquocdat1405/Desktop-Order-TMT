import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb, PDFFont } from "pdf-lib";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

const CUT_OFF_HOUR = 16;
const CONCURRENCY_LIMIT = 10;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL_TIKTOK || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY_TIKTOK ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_TIKTOK ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

let CONFIG = {
  APP_KEY: "",
  APP_SECRET: "",
  ACCESS_TOKEN: "",
  SHOP_CIPHER: "",
  BASE_URL: "https://open-api.tiktokglobalshop.com",
};

function mapStatusToVn(status: string): string {
  const s = String(status).toUpperCase().trim();
  switch (s) {
    case "AWAITING_SHIPMENT": return "Chờ xác nhận";
    case "AWAITING_COLLECTION": return "Chờ lấy hàng";
    case "IN_TRANSIT": return "Đang giao";
    case "DELIVERED": return "Đã giao";
    case "COMPLETED": return "Hoàn thành";
    case "CANCELLED": return "Đã hủy";
    default: return status || "Không rõ trạng thái";
  }
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

async function loadConfigFromSupabase(shopId: string): Promise<boolean> {
  if (!shopId) return false;
  try {
    const { data: cred, error: credError } = await supabase
      .from("shop_credentials")
      .select("*")
      .eq("shop_id", shopId)
      .maybeSingle();

    if (credError || !cred) return false;

    const { data: appData, error: appError } = await supabase
      .from("platform_apps")
      .select("app_key, app_secret")
      .eq("id", cred.platform_app_id)
      .single();

    if (appError || !appData) return false;

    const appKey = String(appData.app_key).trim();
    const appSecret = String(appData.app_secret).trim();
    let accessToken = cred.access_token;
    const shopCipher = cred.shop_cipher || "";

    const now = new Date();
    const expiresAt = cred.access_token_expires_at ? new Date(cred.access_token_expires_at) : new Date(0);

    if (expiresAt.getTime() - now.getTime() < 60 * 60 * 1000) {
      try {
        const refreshUrl = "https://auth.tiktok-shops.com/api/v2/token/refresh";
        const queryParams = new URLSearchParams({
          app_key: appKey,
          app_secret: appSecret,
          refresh_token: cred.refresh_token,
          grant_type: "refresh_token",
        }).toString();

        const res = await fetch(`${refreshUrl}?${queryParams}`, { method: "GET" });
        const refreshData = await res.json();

        if (refreshData.code === 0 && refreshData.data?.access_token) {
          accessToken = refreshData.data.access_token;
          const expiresInSeconds = refreshData.data.access_token_expire_in || 86400;
          const newExpiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

          await supabase
            .from("shop_credentials")
            .update({
              access_token: refreshData.data.access_token,
              refresh_token: refreshData.data.refresh_token || cred.refresh_token,
              access_token_expires_at: newExpiresAt,
              updated_at: new Date().toISOString(),
            })
            .eq("shop_id", shopId);
        }
      } catch (refreshErr) {
        console.error("Lỗi Refresh Token TikTok:", refreshErr);
      }
    }

    CONFIG = {
      APP_KEY: appKey,
      APP_SECRET: appSecret,
      ACCESS_TOKEN: accessToken,
      SHOP_CIPHER: shopCipher,
      BASE_URL: "https://open-api.tiktokglobalshop.com",
    };

    return !!CONFIG.APP_KEY && !!CONFIG.APP_SECRET && !!CONFIG.ACCESS_TOKEN;
  } catch (e) {
    return false;
  }
}

function generateSign(uri: string, qs: Record<string, string>, body: any = null): string {
  const excludeKeys = ["access_token", "sign"];
  const sortedKeys = Object.keys(qs)
    .filter((k) => !excludeKeys.includes(k))
    .sort();
  let paramString = "";
  for (const k of sortedKeys) paramString += `${k}${qs[k]}`;
  
  const pathname = new URL(uri, "https://open-api.tiktokglobalshop.com").pathname.replace("/tiktok-api", "");
  let signString = `${pathname}${paramString}`;
  if (body && Object.keys(body).length > 0) signString += JSON.stringify(body);
  const wrappedString = `${CONFIG.APP_SECRET}${signString}${CONFIG.APP_SECRET}`;
  return crypto
    .createHmac("sha256", CONFIG.APP_SECRET)
    .update(wrappedString, "utf-8")
    .digest("hex");
}

function calculatePickupSlotLogic() {
  const now = new Date();
  const vnTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  let pickupDate = new Date(vnTime);
  let startHour = 16;

  if (vnTime.getHours() >= CUT_OFF_HOUR) {
    pickupDate.setDate(pickupDate.getDate() + 1);
    startHour = 10;
  }
  const s = new Date(Date.UTC(pickupDate.getFullYear(), pickupDate.getMonth(), pickupDate.getDate(), startHour - 7));
  const e = new Date(Date.UTC(pickupDate.getFullYear(), pickupDate.getMonth(), pickupDate.getDate(), startHour - 7));
  
  return {
    start_time: Math.floor(s.getTime() / 1000),
    end_time: Math.floor(e.getTime() / 1000),
  };
}

async function getOrdersDetailBatch(orderIds: string[]): Promise<Record<string, any>> {
  const url = `${CONFIG.BASE_URL}/order/202507/orders`;
  const allMap: Record<string, any> = {};

  const chunks: string[][] = [];
  for (let i = 0; i < orderIds.length; i += 50) {
    chunks.push(orderIds.slice(i, i + 50));
  }

  await runWithConcurrencyLimit(chunks, CONCURRENCY_LIMIT, async (chunk) => {
    const qs: Record<string, string> = {
      ids: chunk.join(","),
      timestamp: Math.floor(Date.now() / 1000).toString(),
      app_key: CONFIG.APP_KEY,
      shop_cipher: CONFIG.SHOP_CIPHER,
    };

    qs["sign"] = generateSign(url, qs);
    const queryParams = new URLSearchParams(qs).toString();

    try {
      const response = await fetch(`${url}?${queryParams}`, {
        method: "GET",
        headers: {
          "x-tts-access-token": CONFIG.ACCESS_TOKEN,
          "content-type": "application/json",
        },
      });
      const data = await response.json();

      if (response.status === 200 && data.code === 0) {
        const orders = data.data?.orders || [];
        for (const order of orders) {
          const pkgs = order.packages || [];
          const items: any[] = [];
          const lineItems = order.line_items || [];

          for (const li of lineItems) {
            const baseQty = parseInt(li.quantity || "1", 10);
            const combined = li.combined_listing_skus || [];

            if (combined.length > 0) {
              for (const c of combined) {
                const rawSku = c.seller_sku || c.sku_id || "UNKNOWN";
                const skuParts = String(rawSku).split("+").map((s: string) => s.trim()).filter(Boolean);
                const skuCount = parseInt(c.sku_count || "1", 10);

                for (const part of skuParts) {
                  let sku = part;
                  let mul = 1;
                  if (part.includes("*")) {
                    const [skuCode, mulStr] = part.split("*");
                    sku = skuCode.trim();
                    mul = parseInt(mulStr, 10) || 1;
                  }
                  items.push({
                    sku: sku,
                    name: li.product_name || li.sku_name || "",
                    qty: baseQty * skuCount * mul,
                  });
                }
              }
            } else {
              const rawSku = li.seller_sku || li.sku_id || "UNKNOWN";
              const skuParts = String(rawSku).split("+").map((s: string) => s.trim()).filter(Boolean);
              for (const part of skuParts) {
                let sku = part;
                let mul = 1;
                if (part.includes("*")) {
                  const [skuCode, mulStr] = part.split("*");
                  sku = skuCode.trim();
                  mul = parseInt(mulStr, 10) || 1;
                }
                items.push({
                  sku: sku,
                  name: li.product_name || li.sku_name || "",
                  qty: baseQty * mul,
                });
              }
            }
          }

          allMap[order.id] = {
            package_id: pkgs[0]?.id || null,
            status: String(order.status || "").toUpperCase().trim(),
            items: items,
          };
        }
      }
    } catch (err) {}
  });

  return allMap;
}

async function batch_ship_packages(packageIds: string[], pickupSlot: any) {
  const url = `${CONFIG.BASE_URL}/fulfillment/202309/packages/ship`;
  const qs: Record<string, string> = {
    timestamp: Math.floor(Date.now() / 1000).toString(),
    app_key: CONFIG.APP_KEY,
    shop_cipher: CONFIG.SHOP_CIPHER,
  };

  const body = {
    packages: packageIds.map((pid) => ({
      id: pid,
      handover_method: "PICKUP",
      pickup_slot: {
        start_time: pickupSlot.start_time,
        end_time: pickupSlot.end_time,
      },
    })),
  };

  qs["sign"] = generateSign(url, qs, body);
  const queryParams = new URLSearchParams(qs).toString();

  try {
    const res = await fetch(`${url}?${queryParams}`, {
      method: "POST",
      headers: {
        "x-tts-access-token": CONFIG.ACCESS_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    const isSuccess = result.code === 0 || result.message === "success";

    return {
      is_success: isSuccess,
      success_list: result.data?.success_list || (isSuccess ? packageIds : []),
      failed_list: result.data?.failed_list || (isSuccess ? [] : packageIds),
      message: result.message || "",
    };
  } catch (e: any) {
    return { is_success: false, success_list: [], failed_list: packageIds, message: e.message };
  }
}

async function getShippingLabelBytes(pid: string): Promise<ArrayBuffer | null> {
  const api = `${CONFIG.BASE_URL}/fulfillment/202309/packages/${pid}/shipping_documents`;
  const qs: Record<string, string> = {
    app_key: CONFIG.APP_KEY,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    shop_cipher: CONFIG.SHOP_CIPHER,
    document_type: "SHIPPING_LABEL_AND_PACKING_SLIP",
    document_format: "PDF",
    document_size: "A6",
  };

  qs["sign"] = generateSign(api, qs);
  const queryParams = new URLSearchParams(qs).toString();

  try {
    const res = await fetch(`${api}?${queryParams}`, {
      method: "GET",
      headers: {
        "x-tts-access-token": CONFIG.ACCESS_TOKEN,
        "content-type": "application/json",
      },
    });
    const d = await res.json();
    if (d.code === 0 && d.data?.doc_url) {
      const fileRes = await fetch(d.data.doc_url);
      return await fileRes.arrayBuffer();
    }
  } catch (e) {}
  return null;
}

async function appendPickingSlipToDoc(
  targetDoc: PDFDocument,
  fontVn: PDFFont,
  groupName: string,
  orderDetailMap: Record<string, any>,
  orderSequence: string[],
  productsDbMap: Record<string, string>
) {
  let page = targetDoc.addPage([419.53, 595.27]);
  const pageWidth = 419.53;

  function drawPageHeader(p: any, isFirstPage: boolean) {
    if (!isFirstPage) return 550;

    const titleText = `PHIẾU XUẤT KHO – ${groupName}`;
    const titleWidth = fontVn.widthOfTextAtSize(titleText, 12);
    p.drawText(titleText, { x: (pageWidth - titleWidth) / 2, y: 565, size: 12, font: fontVn });

    const timeStr = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const timeText = `Thời gian: ${timeStr}`;
    const timeTextWidth = fontVn.widthOfTextAtSize(timeText, 9);
    p.drawText(timeText, { x: (pageWidth - timeTextWidth) / 2, y: 548, size: 9, font: fontVn });

    const totalOrderText = `TỔNG ĐƠN HÀNG: ${orderSequence.length}`;
    const totalOrderWidth = fontVn.widthOfTextAtSize(totalOrderText, 9);
    p.drawText(totalOrderText, { x: (pageWidth - totalOrderWidth) / 2, y: 533, size: 9, font: fontVn });

    return 500;
  }

  let yY = drawPageHeader(page, true);

  const tableX = 15;
  const tableWidth = 390;
  const colWidths = { stt: 25, maDon: 105, sku: 65, tenSp: 160, sl: 35 };

  const headerHeight = 20;
  page.drawRectangle({
    x: tableX,
    y: yY - (headerHeight - 14),
    width: tableWidth,
    height: headerHeight,
    color: rgb(0.92, 0.94, 0.96),
    borderWidth: 0.5,
    borderColor: rgb(0.7, 0.74, 0.8),
  });

  const headers = [
    { text: "STT", x: tableX + colWidths.stt / 2, center: true },
    { text: "MÃ ĐƠN", x: tableX + colWidths.stt + colWidths.maDon / 2, center: true },
    { text: "SKU", x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku / 2, center: true },
    { text: "TÊN SẢN PHẨM", x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp / 2, center: true },
    { text: "SL", x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp + colWidths.sl / 2, center: true },
  ];

  const headerFontSize = 7.5;
  headers.forEach((h) => {
    const tWidth = fontVn.widthOfTextAtSize(h.text, headerFontSize);
    const textX = h.center ? h.x - tWidth / 2 : h.x;
    const textY = yY - (headerHeight - 14) + (headerHeight - headerFontSize) / 2;
    page.drawText(h.text, { x: textX, y: textY, size: headerFontSize, font: fontVn });
  });

  yY -= headerHeight;

  let sttIdx = 1;
  let totalQtySum = 0;
  const skuCounterMap: Record<string, { name: string; qty: number }> = {};

  for (const oid of orderSequence) {
    const info = orderDetailMap[oid] || {};
    const items = info.items || [];

    const mergedSingleOrder: Record<string, { name: string; qty: number }> = {};
    for (const it of items) {
      const sku = String(it.sku).trim();
      if (sku.toLowerCase() === "codeao") continue;

      const dbStandardName = productsDbMap[sku] || it.name || "";
      mergedSingleOrder[sku] = {
        name: dbStandardName,
        qty: (mergedSingleOrder[sku]?.qty || 0) + it.qty,
      };
    }

    let isFirstRowOfOrder = true;
    for (const sku of Object.keys(mergedSingleOrder)) {
      const itemData = mergedSingleOrder[sku];
      const rawName = String(itemData.name || "");
      const fontSizeCell = 6.5;
      const wrappedLines = wrapText(rawName, 150, fontVn, fontSizeCell);
      const rowHeight = Math.max(18, wrappedLines.length * 9 + 6);

      if (yY - rowHeight < 40) {
        page = targetDoc.addPage([419.53, 595.27]);
        yY = drawPageHeader(page, false);

        page.drawRectangle({
          x: tableX,
          y: yY - (headerHeight - 14),
          width: tableWidth,
          height: headerHeight,
          color: rgb(0.92, 0.94, 0.96),
          borderWidth: 0.5,
          borderColor: rgb(0.7, 0.74, 0.8),
        });
        headers.forEach((h) => {
          const tWidth = fontVn.widthOfTextAtSize(h.text, headerFontSize);
          const textX = h.center ? h.x - tWidth / 2 : h.x;
          const textY = yY - (headerHeight - 14) + (headerHeight - headerFontSize) / 2;
          page.drawText(h.text, { x: textX, y: textY, size: headerFontSize, font: fontVn });
        });
        yY -= headerHeight;
      }

      skuCounterMap[sku] = {
        name: rawName,
        qty: (skuCounterMap[sku]?.qty || 0) + itemData.qty,
      };
      totalQtySum += itemData.qty;

      let curX = tableX;
      [colWidths.stt, colWidths.maDon, colWidths.sku, colWidths.tenSp, colWidths.sl].forEach((w) => {
        page.drawRectangle({
          x: curX,
          y: yY - (rowHeight - 14),
          width: w,
          height: rowHeight,
          borderWidth: 0.5,
          borderColor: rgb(0.8, 0.82, 0.85),
        });
        curX += w;
      });

      const centerY = yY - (rowHeight - 14) + (rowHeight - fontSizeCell) / 2;

      if (isFirstRowOfOrder) {
        const sttStr = String(sttIdx++);
        const sttW = fontVn.widthOfTextAtSize(sttStr, fontSizeCell);
        page.drawText(sttStr, { x: tableX + (colWidths.stt - sttW) / 2, y: centerY, size: fontSizeCell, font: fontVn });
        page.drawText(oid, { x: tableX + colWidths.stt + 5, y: centerY, size: fontSizeCell, font: fontVn });
        isFirstRowOfOrder = false;
      } else {
        page.drawRectangle({
          x: tableX,
          y: yY - (rowHeight - 14),
          width: colWidths.stt + colWidths.maDon,
          height: rowHeight,
          color: rgb(0.96, 0.96, 0.96),
          borderWidth: 0.5,
          borderColor: rgb(0.8, 0.82, 0.85),
        });
      }

      page.drawText(sku.substring(0, 15), { x: tableX + colWidths.stt + colWidths.maDon + 5, y: centerY, size: fontSizeCell, font: fontVn });

      const totalTextHeight = wrappedLines.length * 9 - 2;
      const startTextY = yY - (rowHeight - 14) + (rowHeight - totalTextHeight) / 2 + (totalTextHeight - fontSizeCell);

      wrappedLines.forEach((line, lineIdx) => {
        page.drawText(line, {
          x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + 5,
          y: startTextY - lineIdx * 9,
          size: fontSizeCell,
          font: fontVn,
        });
      });

      const qtyStr = String(itemData.qty);
      const qtyW = fontVn.widthOfTextAtSize(qtyStr, fontSizeCell);
      page.drawText(qtyStr, {
        x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp + (colWidths.sl - qtyW) / 2,
        y: centerY,
        size: fontSizeCell,
        font: fontVn,
      });

      yY -= rowHeight;
    }
  }

  const totalRowHeight = 18;
  if (yY - totalRowHeight < 40) {
    page = targetDoc.addPage([419.53, 595.27]);
    yY = drawPageHeader(page, false);
  }

  page.drawRectangle({
    x: tableX,
    y: yY - (totalRowHeight - 14),
    width: tableWidth,
    height: totalRowHeight,
    color: rgb(0.92, 0.94, 0.96),
    borderWidth: 0.5,
    borderColor: rgb(0.7, 0.74, 0.8),
  });

  let sumGridX = tableX;
  [colWidths.stt, colWidths.maDon, colWidths.sku, colWidths.tenSp, colWidths.sl].forEach((w) => {
    page.drawRectangle({
      x: sumGridX,
      y: yY - (totalRowHeight - 14),
      width: w,
      height: totalRowHeight,
      borderWidth: 0.5,
      borderColor: rgb(0.7, 0.74, 0.8),
    });
    sumGridX += w;
  });

  const totalFontSize = 8;
  const centerTotalY = yY - (totalRowHeight - 14) + (totalRowHeight - totalFontSize) / 2;

  page.drawText("TỔNG", { x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + 5, y: centerTotalY, size: totalFontSize, font: fontVn });

  const totalQtyStr = String(totalQtySum);
  const totalQtyW = fontVn.widthOfTextAtSize(totalQtyStr, totalFontSize);
  page.drawText(totalQtyStr, {
    x: tableX + colWidths.stt + colWidths.maDon + colWidths.sku + colWidths.tenSp + (colWidths.sl - totalQtyW) / 2,
    y: centerTotalY,
    size: totalFontSize,
    font: fontVn,
  });

  yY -= totalRowHeight + 35;

  const sumTableWidth = colWidths.stt + colWidths.sku + colWidths.tenSp + colWidths.sl;
  const startSumTableX = (pageWidth - sumTableWidth) / 2;
  const sumHeaderHeight = 20;

  if (yY - 40 < 40) {
    page = targetDoc.addPage([419.53, 595.27]);
    yY = drawPageHeader(page, false);
  }

  const sumSectionTitle = "BẢNG TỔNG SẢN PHẨM";
  const sumSectionTitleWidth = fontVn.widthOfTextAtSize(sumSectionTitle, 10);
  page.drawText(sumSectionTitle, { x: (pageWidth - sumSectionTitleWidth) / 2, y: yY, size: 10, font: fontVn });

  yY -= 18;

  page.drawRectangle({
    x: startSumTableX,
    y: yY - (sumHeaderHeight - 14),
    width: sumTableWidth,
    height: sumHeaderHeight,
    color: rgb(0.88, 0.91, 0.94),
    borderWidth: 0.5,
    borderColor: rgb(0.65, 0.7, 0.75),
  });

  const sumHeadersCorrect = [
    { text: "STT", x: startSumTableX + colWidths.stt / 2, center: true },
    { text: "SKU", x: startSumTableX + colWidths.stt + colWidths.sku / 2, center: true },
    { text: "TÊN SẢN PHẨM", x: startSumTableX + colWidths.stt + colWidths.sku + colWidths.tenSp / 2, center: true },
    { text: "TỔNG SL", x: startSumTableX + colWidths.stt + colWidths.sku + colWidths.tenSp + colWidths.sl / 2, center: true },
  ];

  sumHeadersCorrect.forEach((sh) => {
    const tWidth = fontVn.widthOfTextAtSize(sh.text, 7.5);
    const textX = sh.center ? sh.x - tWidth / 2 : sh.x;
    const textY = yY - (sumHeaderHeight - 14) + (sumHeaderHeight - 7.5) / 2;
    page.drawText(sh.text, { x: textX, y: textY, size: 7.5, font: fontVn });
  });

  yY -= sumHeaderHeight;

  let sumIdx = 1;
  for (const sku of Object.keys(skuCounterMap).sort()) {
    const sumItem = skuCounterMap[sku];
    const fontSizeSumCell = 6.5;
    const wrappedSumLines = wrapText(sumItem.name, 150, fontVn, fontSizeSumCell);
    const sumRowHeight = Math.max(18, wrappedSumLines.length * 9 + 6);

    if (yY - sumRowHeight < 30) {
      page = targetDoc.addPage([419.53, 595.27]);
      yY = drawPageHeader(page, false);

      page.drawRectangle({
        x: startSumTableX,
        y: yY - (sumHeaderHeight - 14),
        width: sumTableWidth,
        height: sumHeaderHeight,
        color: rgb(0.88, 0.91, 0.94),
        borderWidth: 0.5,
        borderColor: rgb(0.65, 0.7, 0.75),
      });
      sumHeadersCorrect.forEach((sh) => {
        const tWidth = fontVn.widthOfTextAtSize(sh.text, 7.5);
        const textX = sh.center ? sh.x - tWidth / 2 : sh.x;
        const textY = yY - (sumHeaderHeight - 14) + (sumHeaderHeight - 7.5) / 2;
        page.drawText(sh.text, { x: textX, y: textY, size: 7.5, font: fontVn });
      });
      yY -= sumHeaderHeight;
    }

    let curSumX = startSumTableX;
    [colWidths.stt, colWidths.sku, colWidths.tenSp, colWidths.sl].forEach((w) => {
      page.drawRectangle({
        x: curSumX,
        y: yY - (sumRowHeight - 14),
        width: w,
        height: sumRowHeight,
        borderWidth: 0.5,
        borderColor: rgb(0.8, 0.82, 0.85),
      });
      curSumX += w;
    });

    const centerSumY = yY - (sumRowHeight - 14) + (sumRowHeight - fontSizeSumCell) / 2;

    const sIdxStr = String(sumIdx++);
    const sIdxW = fontVn.widthOfTextAtSize(sIdxStr, fontSizeSumCell);
    page.drawText(sIdxStr, { x: startSumTableX + (colWidths.stt - sIdxW) / 2, y: centerSumY, size: fontSizeSumCell, font: fontVn });
    page.drawText(sku.substring(0, 15), { x: startSumTableX + colWidths.stt + 5, y: centerSumY, size: fontSizeSumCell, font: fontVn });

    const totalSumTextHeight = wrappedSumLines.length * 9 - 2;
    const startSumTextY = yY - (sumRowHeight - 14) + (sumRowHeight - totalSumTextHeight) / 2 + (totalSumTextHeight - fontSizeSumCell);

    wrappedSumLines.forEach((line, lineIdx) => {
      page.drawText(line, {
        x: startSumTableX + colWidths.stt + colWidths.sku + 5,
        y: startSumTextY - lineIdx * 9,
        size: fontSizeSumCell,
        font: fontVn,
      });
    });

    const sQtyStr = String(sumItem.qty);
    const sQtyW = fontVn.widthOfTextAtSize(sQtyStr, 7);
    page.drawText(sQtyStr, {
      x: startSumTableX + colWidths.stt + colWidths.sku + colWidths.tenSp + (colWidths.sl - sQtyW) / 2,
      y: centerSumY,
      size: 7,
      font: fontVn,
    });

    yY -= sumRowHeight;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action, group_name, order_ids, shop_id, selected_groups_data } = await req.json();

    if (action !== "print" && (!group_name || !order_ids || order_ids.length === 0)) {
      return NextResponse.json(
        { success: false, message: "Tham số truyền vào bị thiếu" },
        { status: 400, headers: corsHeaders },
      );
    }

    const isConfigLoaded = await loadConfigFromSupabase(shop_id);
    if (!isConfigLoaded) {
      return NextResponse.json(
        {
          success: false,
          message: "Không lấy được cấu hình API từ Supabase (Order E-com Manager) cho cửa hàng này",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    // ACTION 1: CONFIRM
    if (action === "confirm") {
      const orderDetailMap = await getOrdersDetailBatch(order_ids);
      const failedDetails: { order_id: string; reason: string }[] = [];

      order_ids.forEach((id: string) => {
        const info = orderDetailMap[id];
        if (!info) failedDetails.push({ order_id: id, reason: "Không tìm thấy đơn trên sàn" });
        else if (!info.package_id) failedDetails.push({ order_id: id, reason: `Thiếu kiện hàng (${mapStatusToVn(info.status)})` });
        else if (info.status !== "AWAITING_SHIPMENT") failedDetails.push({ order_id: id, reason: mapStatusToVn(info.status) });
      });

      const pickupSlot = calculatePickupSlotLogic();
      const validPackageIds = Object.keys(orderDetailMap)
        .filter((oid) => orderDetailMap[oid].status === "AWAITING_SHIPMENT" && orderDetailMap[oid].package_id)
        .map((oid) => orderDetailMap[oid].package_id);

      if (validPackageIds.length === 0) {
        return NextResponse.json({
          success: false,
          success_count: 0,
          failed_count: order_ids.length,
          failed_details: failedDetails,
        }, { headers: corsHeaders });
      }

      const shipResult = await batch_ship_packages(validPackageIds, pickupSlot);
      const successCount = shipResult.is_success ? validPackageIds.length : (shipResult.success_list?.length || 0);

      if (!shipResult.is_success) {
        Object.keys(orderDetailMap).forEach((oid) => {
          if (validPackageIds.includes(orderDetailMap[oid].package_id)) {
            failedDetails.push({
              order_id: oid,
              reason: shipResult.message || "Sàn từ chối duyệt giao hàng"
            });
          }
        });
      }

      return NextResponse.json({
        success: successCount > 0,
        success_count: successCount,
        failed_count: order_ids.length - successCount,
        failed_details: failedDetails,
      }, { headers: corsHeaders });
    }

    // ACTION 2: PRINT (SONG SONG HÓA TOÀN BỘ)
    if (action === "print") {
      let fontBytes: Buffer;
      try {
        const fontPath = path.join(process.cwd(), "public", "DejaVuSans.ttf");
        fontBytes = fs.readFileSync(fontPath);
      } catch (e) {
        return NextResponse.json(
          { success: false, message: "Kiểm tra lại file DejaVuSans.ttf trong thư mục public!" },
          { status: 500, headers: corsHeaders }
        );
      }

      if (!selected_groups_data || selected_groups_data.length === 0) {
        return NextResponse.json(
          { success: false, message: "Không tìm thấy danh sách nhóm P cần in" },
          { status: 400, headers: corsHeaders }
        );
      }

      const resultsPayload: any[] = [];
      const globalFailedDetails: any[] = [];
      let globalSuccessCount = 0;

      // Xử lý song song giữa các nhóm (Group)
      await Promise.all(selected_groups_data.map(async (group: any) => {
        const gName = group.group_name;
        const oIds: string[] = group.order_ids;

        const orderDetailMap = await getOrdersDetailBatch(oIds);
        const groupFailedDetails: any[] = [];

        oIds.forEach((id: string) => {
          const info = orderDetailMap[id];
          if (!info) groupFailedDetails.push({ order_id: id, reason: "Không tìm thấy đơn" });
          else if (!info.package_id) groupFailedDetails.push({ order_id: id, reason: `Thiếu kiện hàng (${mapStatusToVn(info.status)})` });
        });

        const labelMap: Record<string, ArrayBuffer> = {};
        
        // Tải nhãn PDF song song với giới hạn Concurrency
        await runWithConcurrencyLimit(oIds, CONCURRENCY_LIMIT, async (oid: string) => {
          const info = orderDetailMap[oid];
          if (info && info.package_id) {
            const bytes = await getShippingLabelBytes(info.package_id);
            if (bytes) labelMap[oid] = bytes;
            else groupFailedDetails.push({ order_id: oid, reason: mapStatusToVn(info.status) });
          }
        });

        const orderSequenceOk: string[] = [];
        const doubleOrders: string[] = [];

        for (const oid of oIds) {
          if (labelMap[oid]) {
            try {
              const tempDoc = await PDFDocument.load(labelMap[oid]);
              if (tempDoc.getPageCount() >= 2) doubleOrders.push(oid);
            } catch (e) {}
            orderSequenceOk.push(oid);
          }
        }

        const finalSequence = doubleOrders.concat(
          orderSequenceOk.filter((x: string) => !doubleOrders.includes(x))
        );

        let pdfBase64 = "";

        if (finalSequence.length > 0) {
          const finalPdf = await PDFDocument.create();
          finalPdf.registerFontkit(fontkit);
          const fontVn = await finalPdf.embedFont(fontBytes);

          // Trích xuất danh sách SKU song song
          const targetSkus: string[] = [];
          for (const oid of finalSequence) {
            const info = orderDetailMap[oid] || {};
            for (const it of info.items || []) {
              const s = String(it.sku).trim();
              if (!targetSkus.includes(s)) targetSkus.push(s);
            }
          }

          let productsDbMap: Record<string, string> = {};
          if (targetSkus.length > 0) {
            const { data: prodData } = await supabase
              .from("products")
              .select("sku, standard_name")
              .in("sku", targetSkus);

            if (prodData) {
              prodData.forEach((p: any) => {
                if (p.sku) productsDbMap[String(p.sku).trim()] = p.standard_name || "";
              });
            }
          }

          // Ghép 2 nhãn A6 sang 1 trang A5 trực tiếp trên finalPdf
          const orderPages: { oid: string; pindex: number }[] = [];
          const embeddedDocsMap: Record<string, PDFDocument> = {};

          for (const oid of finalSequence) {
            const bytes = labelMap[oid];
            if (!bytes) continue;
            try {
              const srcDoc = await PDFDocument.load(bytes);
              embeddedDocsMap[oid] = srcDoc;
              const count = srcDoc.getPageCount();
              for (let i = 0; i < count; i++) {
                orderPages.push({ oid, pindex: i });
              }
            } catch (e) {}
          }

          const half = Math.ceil(orderPages.length / 2);
          const leftPages = orderPages.slice(0, half);
          const rightPages = orderPages.slice(half);

          const orderIndexMap: Record<string, string> = {};
          finalSequence.forEach((oid, i) => {
            orderIndexMap[oid] = `${gName} - ${i + 1}`;
          });

          const maxLen = Math.max(leftPages.length, rightPages.length);

          for (let i = 0; i < maxLen; i++) {
            const page = finalPdf.addPage([595.27, 419.53]);

            if (i < leftPages.length) {
              const { oid, pindex } = leftPages[i];
              const srcDoc = embeddedDocsMap[oid];
              const [copiedPage] = await finalPdf.copyPages(srcDoc, [pindex]);
              const embeddedPage = await finalPdf.embedPage(copiedPage);

              await page.drawPage(embeddedPage, { x: 0, y: 0, width: 297.63, height: 419.53 });

              const labelText = orderIndexMap[oid];
              const textWidth = fontVn.widthOfTextAtSize(labelText, 11);
              const centerXLeft = (297.63 - textWidth) / 2;

              page.drawText(labelText, { x: centerXLeft, y: 15, size: 11, font: fontVn, color: rgb(0, 0, 0) });
            }

            if (i < rightPages.length) {
              const { oid, pindex } = rightPages[i];
              const srcDoc = embeddedDocsMap[oid];
              const [copiedPage] = await finalPdf.copyPages(srcDoc, [pindex]);
              const embeddedPage = await finalPdf.embedPage(copiedPage);

              await page.drawPage(embeddedPage, { x: 297.63, y: 0, width: 297.63, height: 419.53 });

              const labelText = orderIndexMap[oid];
              const textWidth = fontVn.widthOfTextAtSize(labelText, 11);
              const centerXRight = 297.63 + (297.63 - textWidth) / 2;

              page.drawText(labelText, { x: centerXRight, y: 15, size: 11, font: fontVn, color: rgb(0, 0, 0) });
            }
          }

          // Ghép Phiếu Xuất Kho trực tiếp vào finalPdf
          await appendPickingSlipToDoc(finalPdf, fontVn, gName, orderDetailMap, finalSequence, productsDbMap);

          // 🚀 NÉN STREAM PDF TỐI ĐA (Giảm 40-60% dung lượng file)
          const finalPdfBuffer = await finalPdf.save({ useObjectStreams: true });
          pdfBase64 = Buffer.from(finalPdfBuffer).toString("base64");

          globalSuccessCount += finalSequence.length;
        }

        resultsPayload.push({
          group_name: gName,
          success_count: finalSequence.length,
          pdf_base64: pdfBase64,
          failed_details: groupFailedDetails
        });

        globalFailedDetails.push(...groupFailedDetails);
      }));

      return NextResponse.json({
        success: true,
        total_success_orders: globalSuccessCount,
        files: resultsPayload,
        all_failed_details: globalFailedDetails
      }, { headers: corsHeaders });
    }

    return NextResponse.json(
      { success: false, message: "Hành động gửi lên không hợp lệ" },
      { status: 400, headers: corsHeaders },
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, message: error.message },
      { status: 500, headers: corsHeaders },
    );
  }
}
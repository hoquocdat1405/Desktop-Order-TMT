"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Search, Loader2, CheckCircle2, XCircle, Clock, Store, RefreshCw, History, PlusCircle, Copy, Trash2, ChevronDown, ChevronRight, FolderOpen, HardDrive, FolderCheck, AlertTriangle } from "lucide-react";
import { createClient } from "@supabase/supabase-js";
import { useUserShops } from "@/hooks/useUserShops";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "";

// Khai báo fallback Supabase Keys trực tiếp để tránh lỗi bị mất .env khi Build Electron .exe
const SUPABASE_URL_SHOPEE = process.env.NEXT_PUBLIC_SUPABASE_URL_SHOPEE || "";
const SUPABASE_ANON_SHOPEE = process.env.SUPABASE_SERVICE_ROLE_KEY_SHOPEE || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_SHOPEE || "";

const SUPABASE_URL_TIKTOK = process.env.NEXT_PUBLIC_SUPABASE_URL_TIKTOK || "";
const SUPABASE_ANON_TIKTOK = process.env.SUPABASE_SERVICE_ROLE_KEY_TIKTOK || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_TIKTOK || "";

// Khởi tạo 2 Supabase Client
const supabaseShopee = createClient(SUPABASE_URL_SHOPEE, SUPABASE_ANON_SHOPEE);
const supabaseTiktok = createClient(SUPABASE_URL_TIKTOK, SUPABASE_ANON_TIKTOK);

interface HistoryItem {
  id: string;
  timestamp: string;
  group_name: string;
  action_type: "Xác nhận" | "In nhãn";
  total_count: number;
  success_count: number;
  failed_count: number;
  failed_details?: { order_id: string; reason: string }[];
}

interface CustomAlertState {
  isOpen: boolean;
  title: string;
  message: string;
  type: "success" | "error" | "warning" | "info";
}

interface CustomConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

interface GroupProgress {
  groupName: string;
  status: "pending" | "processing" | "success" | "error";
  message?: string;
}

interface ProgressModalState {
  isOpen: boolean;
  title: string;
  actionType: "confirm" | "print" | null;
  currentGroup: string;
  completedCount: number;
  totalCount: number;
  groupsProgress: GroupProgress[];
}

interface ShopItem {
  id: string;
  name: string;
  platform: "shopee" | "tiktok";
}

export default function OrdersProcessing() {
  const { allowedShopIds, loadingShops } = useUserShops();

  // 🎯 REF DÙNG ĐỂ TỰ ĐỘNG CUỘN BẢNG DƯỚI CÙNG
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const [availableShops, setAvailableShops] = useState<ShopItem[]>([]);
  const [selectedShopId, setSelectedShopId] = useState<string>("");
  const [isShopDropdownOpen, setIsShopDropdownOpen] = useState(false);
  const [isFetchShopsLoading, setIsFetchShopsLoading] = useState(true);

  const [rawInput, setRawInput] = useState("");
  const [startPNumber, setStartPNumber] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentAction, setCurrentAction] = useState<"confirm" | "print" | null>(null);

  const [downloadDirPaths, setDownloadDirPaths] = useState<Record<string, string>>({});
  const [isSelectingFolder, setIsSelectingFolder] = useState<boolean>(false);

  const [progressState, setProgressState] = useState<ProgressModalState>({
    isOpen: false,
    title: "",
    actionType: null,
    currentGroup: "",
    completedCount: 0,
    totalCount: 0,
    groupsProgress: [],
  });

  const [alertState, setAlertState] = useState<CustomAlertState>({
    isOpen: false,
    title: "",
    message: "",
    type: "success",
  });

  const [confirmState, setConfirmState] = useState<CustomConfirmState>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });

  const [groupsMap, setGroupsMap] = useState<Record<string, any[]>>({});
  const [historyMap, setHistoryMap] = useState<Record<string, HistoryItem[]>>({});

  const [copyOptions, setCopyOptions] = useState<{ space: boolean; semicolon: boolean }>({
    space: true,
    semicolon: true,
  });

  // 🎯 QUẢN LÝ SELECTED GROUPS THEO TỪNG SHOP_ID ĐỂ TRÁNH BỊ MẤT TICK KHI CHUYỂN GIAN HÀNG
  const [selectedGroupsMap, setSelectedGroupsMap] = useState<Record<string, string[]>>({});

  const selectedGroups = useMemo(() => {
    return selectedShopId ? selectedGroupsMap[selectedShopId] || [] : [];
  }, [selectedGroupsMap, selectedShopId]);

  const setSelectedGroups = (action: string[] | ((prev: string[]) => string[])) => {
    if (!selectedShopId) return;
    setSelectedGroupsMap((prevMap) => {
      const currentList = prevMap[selectedShopId] || [];
      const newList = typeof action === "function" ? action(currentList) : action;
      return { ...prevMap, [selectedShopId]: newList };
    });
  };

  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const showAlert = (
    title: string,
    message: string,
    type: "success" | "error" | "warning" | "info" = "success"
  ) => {
    setAlertState({ isOpen: true, title, message, type });
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setConfirmState({
      isOpen: true,
      title,
      message,
      onConfirm,
    });
  };

  const currentShopDownloadDirPath = useMemo(() => {
    return selectedShopId ? downloadDirPaths[selectedShopId] || "" : "";
  }, [selectedShopId, downloadDirPaths]);

  useEffect(() => {
    if (!selectedShopId) return;
    const savedPath = localStorage.getItem(`ecom_download_dir_path_${selectedShopId}`);
    if (savedPath) {
      setDownloadDirPaths((prev) => ({ ...prev, [selectedShopId]: savedPath }));
    }
  }, [selectedShopId]);

  const handleSelectDownloadFolder = async () => {
    if (!selectedShopId) return showAlert("Cảnh báo", "Vui lòng chọn gian hàng trước!", "warning");
    if (isSelectingFolder) return;

    setIsSelectingFolder(true);

    try {
      if (typeof window !== "undefined" && (window as any).require) {
        const { ipcRenderer } = (window as any).require("electron");
        const folderPath = await ipcRenderer.invoke("select-folder");

        if (folderPath) {
          setDownloadDirPaths((prev) => ({ ...prev, [selectedShopId]: folderPath }));
          localStorage.setItem(`ecom_download_dir_path_${selectedShopId}`, folderPath);
        }
      }
    } catch (err: any) {
      console.error("Lỗi chọn thư mục:", err);
    } finally {
      setIsSelectingFolder(false);
    }
  };

  useEffect(() => {
    let isMounted = true;

    async function fetchShops() {
      if (!SUPABASE_URL_SHOPEE && !SUPABASE_URL_TIKTOK) {
        console.error("⚠️ LỖI: Thiếu SUPABASE URL trong file .env.local!");
        if (isMounted) setIsFetchShopsLoading(false);
        return;
      }

      try {
        let shopeeShops: ShopItem[] = [];
        let tiktokShops: ShopItem[] = [];

        if (SUPABASE_URL_SHOPEE) {
          let queryShopee = supabaseShopee
            .from("shops")
            .select("shop_id, shop_name, platforms(platform_name)");
          
          if (allowedShopIds && allowedShopIds.length > 0) {
            queryShopee = queryShopee.in("shop_id", allowedShopIds);
          }

          const { data, error } = await queryShopee;
          if (error) console.error("Lỗi query Shopee:", error);
          else {
            shopeeShops = (data || []).map((s: any) => ({
              id: s.shop_id,
              name: s.shop_name || "Gian hàng Shopee",
              platform: "shopee",
            }));
          }
        }

        if (SUPABASE_URL_TIKTOK) {
          let queryTiktok = supabaseTiktok
            .from("shops")
            .select("shop_id, shop_name, platforms!inner(platform_name)");

          if (allowedShopIds && allowedShopIds.length > 0) {
            queryTiktok = queryTiktok.in("shop_id", allowedShopIds);
          }

          const { data, error } = await queryTiktok;
          if (error) console.error("Lỗi query TikTok:", error);
          else {
            tiktokShops = (data || [])
              .filter((s: any) => {
                const rawPlatform = Array.isArray(s.platforms)
                  ? s.platforms[0]?.platform_name
                  : s.platforms?.platform_name;
                return String(rawPlatform || "").toLowerCase().includes("tiktok");
              })
              .map((s: any) => ({
                id: s.shop_id,
                name: s.shop_name || "Gian hàng TikTok",
                platform: "tiktok",
              }));
          }
        }

        const combinedMap = new Map<string, ShopItem>();
        shopeeShops.forEach((item) => combinedMap.set(item.id, item));
        tiktokShops.forEach((item) => combinedMap.set(item.id, item));

        const formatted = Array.from(combinedMap.values());

        if (isMounted) {
          setAvailableShops(formatted);
          if (formatted.length > 0 && !selectedShopId) {
            setSelectedShopId(formatted[0].id);
          }
        }
      } catch (err) {
        console.error("Lỗi tải danh sách shop:", err);
      } finally {
        if (isMounted) {
          setIsFetchShopsLoading(false);
        }
      }
    }

    fetchShops();

    return () => {
      isMounted = false;
    };
  }, [allowedShopIds]);

  useEffect(() => {
    if (!selectedShopId) return;

    const savedGroups = localStorage.getItem(`ecom_groups_${selectedShopId}`);
    const savedHistory = localStorage.getItem(`ecom_history_${selectedShopId}`);

    if (savedGroups) {
      setGroupsMap((prev) => ({ ...prev, [selectedShopId]: JSON.parse(savedGroups) }));
    }
    if (savedHistory) {
      setHistoryMap((prev) => ({ ...prev, [selectedShopId]: JSON.parse(savedHistory) }));
    }

    const savedCopyOpt = localStorage.getItem("ecom_copy_options");
    if (savedCopyOpt) setCopyOptions(JSON.parse(savedCopyOpt));
  }, [selectedShopId]);

  const currentShop = useMemo(
    () => availableShops.find((s) => s.id === selectedShopId),
    [availableShops, selectedShopId]
  );

  const currentGroups = useMemo(
    () => (selectedShopId ? groupsMap[selectedShopId] || [] : []),
    [groupsMap, selectedShopId]
  );

  const currentHistory = useMemo(
    () => (selectedShopId ? historyMap[selectedShopId] || [] : []),
    [historyMap, selectedShopId]
  );

  const currentApiEndpoint = useMemo(() => {
    const path = currentShop?.platform === "tiktok" ? "/api/v1/tiktok" : "/api/v1/shopee";
    return `${BASE_URL}${path}`;
  }, [currentShop]);

  const updateGroupsData = (updatedData: any[]) => {
    if (!selectedShopId) return;
    setGroupsMap((prev) => ({ ...prev, [selectedShopId]: updatedData }));
    localStorage.setItem(`ecom_groups_${selectedShopId}`, JSON.stringify(updatedData));
  };

  const addHistoryItem = (newItem: Omit<HistoryItem, "id" | "timestamp">) => {
    if (!selectedShopId) return;
    const completedItem: HistoryItem = {
      ...newItem,
      id: "HIST-" + Date.now() + Math.random().toString(36).substring(2, 5).toUpperCase(),
      timestamp: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
    };

    setHistoryMap((prev) => {
      const currentList = prev[selectedShopId] || [];
      const updated = [completedItem, ...currentList];
      localStorage.setItem(`ecom_history_${selectedShopId}`, JSON.stringify(updated));
      return { ...prev, [selectedShopId]: updated };
    });
  };

  const handleCopyOptionChange = (key: "space" | "semicolon", checked: boolean) => {
    const updated = { ...copyOptions, [key]: checked };
    setCopyOptions(updated);
    localStorage.setItem("ecom_copy_options", JSON.stringify(updated));
  };

  useEffect(() => {
    setExpandedGroups([]);
    setEditingId(null);
    setCurrentAction(null);
  }, [selectedShopId]);

  const getSelectedButtonsLabel = () => {
    let confirmLabel = "XÁC NHẬN";
    let printLabel = "IN HÀNG LOẠT";

    if (selectedGroups.length > 0) {
      const selectedData = currentGroups.filter((g) => selectedGroups.includes(g.group_name));
      const hasPrinted = selectedData.some((g) => g.status === "Đã in");
      const hasConfirmed = selectedData.some((g) => g.status === "Đã xác nhận");

      if (hasPrinted && currentAction === "confirm") {
        confirmLabel = "DUYỆT LẠI ĐƠN (API)";
      }
      if (hasConfirmed && currentAction === "print") {
        printLabel = "IN LẠI HÀNG LOẠT (TỰ ĐỘNG GHÉP FILE)";
      }
    }

    return { confirmLabel, printLabel };
  };

  const { confirmLabel, printLabel } = getSelectedButtonsLabel();

  // 🔥 HÀM CHIA NHÓM THÔNG MINH + AUTO SELECT + AUTO SCROLL DOWN
  const handleMakeGroups = () => {
    if (!rawInput.trim()) return showAlert("Nhắc nhở", "Vui lòng dán danh sách đơn hàng!", "warning");
    if (!selectedShopId) return showAlert("Cảnh báo", "Vui lòng chọn gian hàng xử lý!", "warning");

    const rows = rawInput.split("\n").map((r) => r.trim()).filter(Boolean);
    const parsedRows: { pGroup?: string; method: string; id: string }[] = [];
    const localSeenIds = new Set();

    rows.forEach((row) => {
      let parts = row.split(/[\t]+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      
      if (parts.length < 2 && row.includes(" ")) {
        parts = row.split(/\s+/).map((p) => p.trim()).filter(Boolean);
      }

      if (parts.length >= 3) {
        // TRƯỜNG HỢP 3 CỘT: [Ngày-Giờ-P14] [ĐVVC] [Mã Đơn]
        const rawGroup = parts[0];
        const id = parts[parts.length - 1];
        const method = parts.slice(1, parts.length - 1).join(" ");

        // 🎯 BÓC TÁCH LẤY ĐÚNG CHUỖI "P" + "SỐ" (Ví dụ: 04.09-15h3-P14 -> P14)
        const matchP = rawGroup.match(/P\d+/i);
        const pGroup = matchP ? matchP[0].toUpperCase() : rawGroup;

        if (id && method && !localSeenIds.has(id)) {
          localSeenIds.add(id);
          parsedRows.push({ pGroup, method, id });
        }
      } else if (parts.length === 2) {
        // TRƯỜNG HỢP 2 CỘT: [ĐVVC] [Mã Đơn]
        const method = parts[0];
        const id = parts[1];

        if (id && method && !localSeenIds.has(id)) {
          localSeenIds.add(id);
          parsedRows.push({ method, id });
        }
      }
    });

    if (parsedRows.length === 0)
      return showAlert("Nhắc nhở", "Không tìm thấy dữ liệu hợp lệ để chia nhóm!", "warning");

    const isThreeColumnsFormat = parsedRows.some((r) => !!r.pGroup);
    const blocks: { groupName: string; method: string; orders: string[] }[] = [];

    if (isThreeColumnsFormat) {
      const groupMap = new Map<string, { method: string; orders: string[] }>();

      parsedRows.forEach((row) => {
        const gName = row.pGroup || "P-KHONG-TEN";
        if (!groupMap.has(gName)) {
          groupMap.set(gName, { method: row.method, orders: [row.id] });
        } else {
          const current = groupMap.get(gName)!;
          if (current.orders.length < 50) {
            current.orders.push(row.id);
          } else {
            let subIndex = 2;
            let subGName = `${gName}_${subIndex}`;
            while (groupMap.has(subGName) && groupMap.get(subGName)!.orders.length >= 50) {
              subIndex++;
              subGName = `${gName}_${subIndex}`;
            }
            if (!groupMap.has(subGName)) {
              groupMap.set(subGName, { method: row.method, orders: [row.id] });
            } else {
              groupMap.get(subGName)!.orders.push(row.id);
            }
          }
        }
      });

      groupMap.forEach((val, key) => {
        blocks.push({ groupName: key, method: val.method, orders: val.orders });
      });
    } else {
      let nextPNum = parseInt(startPNumber) || 0;
      if (!nextPNum) {
        if (currentGroups.length > 0) {
          const allPNumbers = currentGroups.map((g) => parseInt(g.group_name.replace(/[^\d]/g, "")) || 0);
          nextPNum = Math.max(...allPNumbers) + 1;
        } else {
          nextPNum = 1;
        }
      }

      let currentBlockOrders: string[] = [];
      let currentMethod = "";

      parsedRows.forEach((order) => {
        if (currentMethod !== order.method || currentBlockOrders.length >= 50) {
          if (currentBlockOrders.length > 0) {
            blocks.push({ groupName: `P${nextPNum++}`, method: currentMethod, orders: currentBlockOrders });
          }
          currentMethod = order.method;
          currentBlockOrders = [order.id];
        } else {
          currentBlockOrders.push(order.id);
        }
      });
      if (currentBlockOrders.length > 0) {
        blocks.push({ groupName: `P${nextPNum++}`, method: currentMethod, orders: currentBlockOrders });
      }
    }

    const incomingNames = blocks.map((b) => b.groupName);
    const hasDuplicate = incomingNames.some((name) => currentGroups.some((g) => g.group_name === name));

    const executeGroupCreation = () => {
      let tempCurrentGroups = [...currentGroups].filter((g) => !incomingNames.includes(g.group_name));

      const generatedGroups = blocks.map((block) => ({
        group_name: block.groupName,
        shipping_method: block.method,
        status: "Chưa xử lý",
        orders: block.orders.map((id) => ({
          platform_order_id: id,
          shop_id: selectedShopId,
        })),
      }));

      const updatedGroups = [...tempCurrentGroups, ...generatedGroups];

      updateGroupsData(updatedGroups);
      
      // 🎯 TỰ ĐỘNG BỎ CÁC CŨ VÀ TÍCH CHỌN CÁC NHÓM MỚI NHẬP
      setSelectedGroups(incomingNames);

      setRawInput("");
      setStartPNumber("");
      setIsModalOpen(false);
      showAlert("Thành công", `Đã tạo ${generatedGroups.length} nhóm P mới!`, "success");

      // 🚀 TỰ ĐỘNG CUỘN XUỐNG ĐÁY BẢNG
      setTimeout(() => {
        if (tableContainerRef.current) {
          tableContainerRef.current.scrollTo({
            top: tableContainerRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      }, 200);
    };

    if (hasDuplicate) {
      showConfirm(
        "Trùng tên nhóm P",
        `Có tên nhóm P bị trùng với danh sách hiện tại. Bạn có muốn ghi đè lên các nhóm bị trùng?`,
        executeGroupCreation
      );
    } else {
      executeGroupCreation();
    }
  };

  const startEditing = (e: React.MouseEvent, id: string, initialValue: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditValue(initialValue);
  };

  const saveInlineEdit = (groupName: string, field: "name" | "method" | "order_id", orderId?: string) => {
    const updatedGroups = currentGroups.map((g) => {
      if (g.group_name === groupName) {
        if (field === "name") return { ...g, group_name: editValue.trim() };
        if (field === "method") return { ...g, shipping_method: editValue.trim() };
        if (field === "order_id" && orderId) {
          return {
            ...g,
            orders: g.orders.map((o: any) =>
              o.platform_order_id === orderId ? { ...o, platform_order_id: editValue.trim() } : o
            ),
          };
        }
      }
      return g;
    });
    updateGroupsData(updatedGroups);
    setEditingId(null);
  };

  const toggleExpandGroup = (gName: string) => {
    setExpandedGroups((prev) => (prev.includes(gName) ? prev.filter((x) => x !== gName) : [...prev, gName]));
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedGroups(filteredGroups.map((g) => g.group_name));
    } else {
      setSelectedGroups([]);
    }
  };

  const handleClearAll = () => {
    showConfirm(
      "Làm mới danh sách",
      `Xóa sạch danh sách khối của gian hàng ${currentShop?.name}?`,
      () => {
        updateGroupsData([]);
        setSelectedGroups([]);
        setExpandedGroups([]);
        setCurrentAction(null);
      }
    );
  };

  const handleDeleteGroup = (e: React.MouseEvent, gName: string) => {
    e.stopPropagation();
    showConfirm(
      "Xóa nhóm P",
      `Bạn có chắc chắn muốn xóa nhóm ${gName}?`,
      () => {
        const updated = currentGroups.filter((g) => g.group_name !== gName);
        updateGroupsData(updated);
        setSelectedGroups((prev) => prev.filter((x) => x !== gName));
      }
    );
  };

  const handleDeleteSingleOrder = (e: React.MouseEvent, gName: string, orderId: string) => {
    e.stopPropagation();
    showConfirm(
      "Xóa đơn hàng",
      `Xóa đơn ${orderId} ra khỏi ${gName}?`,
      () => {
        const updated = currentGroups
          .map((g) => {
            if (g.group_name === gName) {
              const filteredOrders = g.orders.filter((o: any) => o.platform_order_id !== orderId);
              return { ...g, orders: filteredOrders };
            }
            return g;
          })
          .filter((g) => g.orders.length > 0);

        updateGroupsData(updated);
      }
    );
  };

  const handleCopyOrderIds = (e: React.MouseEvent, gName: string) => {
    e.stopPropagation();
    const groupData = currentGroups.find((g) => g.group_name === gName);
    if (!groupData || !groupData.orders?.length) return;

    const ids = groupData.orders.map((o: any) => o.platform_order_id);

    let separator = "\n";
    if (copyOptions.space && copyOptions.semicolon) {
      separator = " ; ";
    } else if (copyOptions.semicolon) {
      separator = ";";
    } else if (copyOptions.space) {
      separator = " ";
    }

    const compiledText = ids.join(separator);
    navigator.clipboard.writeText(compiledText).catch((err) => console.error(err));
  };

  const executeConfirmOrdersAPI = async () => {
    setLoading(true);
    setCurrentAction("confirm");

    const initialProgressList: GroupProgress[] = selectedGroups.map((gName) => ({
      groupName: gName,
      status: "pending",
    }));

    setProgressState({
      isOpen: true,
      title: `ĐANG XÁC NHẬN ĐƠN - ${currentShop?.name.toUpperCase()}`,
      actionType: "confirm",
      currentGroup: selectedGroups[0] || "",
      completedCount: 0,
      totalCount: selectedGroups.length,
      groupsProgress: initialProgressList,
    });

    let localGroups = [...currentGroups];

    try {
      for (let i = 0; i < selectedGroups.length; i++) {
        const gName = selectedGroups[i];

        setProgressState((prev) => ({
          ...prev,
          currentGroup: gName,
          groupsProgress: prev.groupsProgress.map((gp) =>
            gp.groupName === gName ? { ...gp, status: "processing" } : gp
          ),
        }));

        const groupData = localGroups.find((g) => g.group_name === gName);
        if (!groupData || !groupData.orders?.length) {
          setProgressState((prev) => ({
            ...prev,
            completedCount: i + 1,
            groupsProgress: prev.groupsProgress.map((gp) =>
              gp.groupName === gName ? { ...gp, status: "error", message: "Không có đơn" } : gp
            ),
          }));
          continue;
        }

        const orderIds = groupData.orders.map((o: any) => o.platform_order_id);
        const targetShopId = groupData.orders[0]?.shop_id || selectedShopId;

        const requestBody = {
          action: "confirm",
          group_name: gName,
          order_ids: orderIds,
          shop_id: targetShopId,
        };

        try {
          const response = await fetch(currentApiEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });

          const result = await response.json();

          if (response.ok && result?.success) {
            const resSuccessCount = result.success_count ?? 0;
            const resFailedCount = result.failed_count ?? 0;

            if (resSuccessCount > 0) {
              localGroups = localGroups.map((g) => (g.group_name === gName ? { ...g, status: "Đã xác nhận" } : g));
              updateGroupsData(localGroups);
            }

            addHistoryItem({
              group_name: gName,
              action_type: "Xác nhận",
              total_count: orderIds.length,
              success_count: resSuccessCount,
              failed_count: resFailedCount,
              failed_details: result.failed_details || [],
            });

            setProgressState((prev) => ({
              ...prev,
              completedCount: i + 1,
              groupsProgress: prev.groupsProgress.map((gp) =>
                gp.groupName === gName
                  ? {
                      ...gp,
                      status: resFailedCount > 0 ? (resSuccessCount > 0 ? "success" : "error") : "success",
                    }
                  : gp
              ),
            }));
          } else {
            const errorMsg = result?.message;

            addHistoryItem({
              group_name: gName,
              action_type: "Xác nhận",
              total_count: orderIds.length,
              success_count: 0,
              failed_count: orderIds.length,
              failed_details: result?.failed_details || orderIds.map((id: string) => ({ order_id: id, reason: errorMsg })),
            });

            setProgressState((prev) => ({
              ...prev,
              completedCount: i + 1,
              groupsProgress: prev.groupsProgress.map((gp) =>
                gp.groupName === gName ? { ...gp, status: "error", message: errorMsg } : gp
              ),
            }));
          }
        } catch (err: any) {
          addHistoryItem({
            group_name: gName,
            action_type: "Xác nhận",
            total_count: orderIds.length,
            success_count: 0,
            failed_count: orderIds.length,
            failed_details: orderIds.map((id: string) => ({ order_id: id, reason: "Lỗi kết nối máy chủ" })),
          });

          setProgressState((prev) => ({
            ...prev,
            completedCount: i + 1,
            groupsProgress: prev.groupsProgress.map((gp) =>
              gp.groupName === gName ? { ...gp, status: "error", message: "Lỗi kết nối" } : gp
            ),
          }));
        }
      }

      setProgressState((prev) => ({
        ...prev,
        title: "XÁC NHẬN ĐƠN THÀNH CÔNG",
      }));
    } finally {
      setLoading(false);
      setCurrentAction(null);
    }
  };

  const handleConfirmOrdersAPI = () => {
    if (!selectedShopId) return showAlert("Cảnh báo", "Vui lòng chọn gian hàng!", "warning");
    if (selectedGroups.length === 0) return showAlert("Nhắc nhở", "Vui lòng tích chọn nhóm P cần duyệt!", "warning");

    showConfirm(
      "Xác nhận duyệt đơn hàng",
      `Bạn có chắc chắn muốn duyệt ${selectedGroups.length} nhóm P đã chọn qua API sàn?`,
      executeConfirmOrdersAPI
    );
  };

  const executePrintBatch = async () => {
    setLoading(true);
    setCurrentAction("print");

    const initialProgressList: GroupProgress[] = selectedGroups.map((gName) => ({
      groupName: gName,
      status: "pending",
    }));

    setProgressState({
      isOpen: true,
      title: "ĐANG TẠO FILE IN",
      actionType: "print",
      currentGroup: selectedGroups[0] || "",
      completedCount: 0,
      totalCount: selectedGroups.length,
      groupsProgress: initialProgressList,
    });

    const collectedFiles: any[] = [];
    let localGroups = [...currentGroups];

    try {
      for (let i = 0; i < selectedGroups.length; i++) {
        const gName = selectedGroups[i];

        setProgressState((prev) => ({
          ...prev,
          currentGroup: gName,
          groupsProgress: prev.groupsProgress.map((gp) =>
            gp.groupName === gName ? { ...gp, status: "processing" } : gp
          ),
        }));

        const groupData = localGroups.find((g) => g.group_name === gName);
        const orderIds = groupData?.orders?.map((o: any) => o.platform_order_id) || [];
        const targetShopId = groupData?.orders[0]?.shop_id || selectedShopId;

        if (orderIds.length === 0) {
          setProgressState((prev) => ({
            ...prev,
            completedCount: i + 1,
            groupsProgress: prev.groupsProgress.map((gp) =>
              gp.groupName === gName ? { ...gp, status: "error", message: "Không có đơn" } : gp
            ),
          }));
          continue;
        }

        try {
          const response = await fetch(currentApiEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "print",
              group_name: gName,
              selected_groups_data: [{ group_name: gName, order_ids: orderIds }],
              shop_id: targetShopId,
            }),
          });

          if (response.ok) {
            const result = await response.json();
            if (result.success && result.files && result.files.length > 0) {
              const fileItem = result.files[0];
              const succCount = fileItem.success_count || 0;
              const failCount = orderIds.length - succCount;

              if (succCount > 0) {
                collectedFiles.push(fileItem);

                localGroups = localGroups.map((g) => (g.group_name === gName ? { ...g, status: "Đã in" } : g));
                updateGroupsData(localGroups);
              }

              addHistoryItem({
                group_name: gName,
                action_type: "In nhãn",
                total_count: orderIds.length,
                success_count: succCount,
                failed_count: failCount,
                failed_details: fileItem.failed_details || [],
              });

              setProgressState((prev) => ({
                ...prev,
                completedCount: i + 1,
                groupsProgress: prev.groupsProgress.map((gp) =>
                  gp.groupName === gName
                    ? {
                        ...gp,
                        status: succCount > 0 ? "success" : "error",
                      }
                    : gp
                ),
              }));
            } else {
              addHistoryItem({
                group_name: gName,
                action_type: "In nhãn",
                total_count: orderIds.length,
                success_count: 0,
                failed_count: orderIds.length,
                failed_details: orderIds.map((id: string) => ({ order_id: id, reason: result.message || "Không tạo được file" })),
              });

              setProgressState((prev) => ({
                ...prev,
                completedCount: i + 1,
                groupsProgress: prev.groupsProgress.map((gp) =>
                  gp.groupName === gName ? { ...gp, status: "error", message: result.message || "Không tạo được file" } : gp
                ),
              }));
            }
          } else {
            const errRes = await response.json();
            addHistoryItem({
              group_name: gName,
              action_type: "In nhãn",
              total_count: orderIds.length,
              success_count: 0,
              failed_count: orderIds.length,
              failed_details: orderIds.map((id: string) => ({ order_id: id, reason: errRes.message || "Lỗi tạo PDF" })),
            });

            setProgressState((prev) => ({
              ...prev,
              completedCount: i + 1,
              groupsProgress: prev.groupsProgress.map((gp) =>
                gp.groupName === gName ? { ...gp, status: "error", message: errRes.message || "Lỗi PDF" } : gp
              ),
            }));
          }
        } catch (err) {
          addHistoryItem({
            group_name: gName,
            action_type: "In nhãn",
            total_count: orderIds.length,
            success_count: 0,
            failed_count: orderIds.length,
            failed_details: orderIds.map((id: string) => ({ order_id: id, reason: "Lỗi kết nối máy chủ" })),
          });

          setProgressState((prev) => ({
            ...prev,
            completedCount: i + 1,
            groupsProgress: prev.groupsProgress.map((gp) =>
              gp.groupName === gName ? { ...gp, status: "error", message: "Lỗi kết nối" } : gp
            ),
          }));
        }
      }

      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}`;
      const timeStr = `${String(now.getHours()).padStart(2, "0")}h${String(now.getMinutes()).padStart(2, "0")}`;
      const shopNamePrefix = currentShop?.name ? currentShop.name.trim() : "GianHang";

      const validFiles = collectedFiles.filter((f: any) => f.pdf_base64);
      const totalOrdersInBatch = validFiles.reduce((sum: number, item: any) => sum + (item.success_count || 0), 0);

      if (validFiles.length > 0) {
        if (typeof window !== "undefined" && (window as any).require) {
          const { ipcRenderer } = (window as any).require("electron");

          const subFolderName = `${shopNamePrefix} - ${dateStr} ${timeStr} - ${totalOrdersInBatch} đơn`;
          const targetSubFolderPath = `${currentShopDownloadDirPath}/${subFolderName}`.replace(/\\/g, "/");

          for (const fileItem of validFiles) {
            const individualFileName = `${shopNamePrefix} - ${dateStr} - ${fileItem.group_name} - ${fileItem.success_count} đơn.pdf`;

            await ipcRenderer.invoke("save-pdf-file", {
              folderPath: targetSubFolderPath,
              fileName: individualFileName,
              base64Data: fileItem.pdf_base64,
            });
          }
        }
      }

      setProgressState((prev) => ({
        ...prev,
        title: "TẠO FILE THÀNH CÔNG",
      }));
    } finally {
      setLoading(false);
      setCurrentAction(null);
    }
  };

  const handlePrintBatch = () => {
    if (!selectedShopId) return showAlert("Cảnh báo", "Vui lòng chọn gian hàng!", "warning");
    if (selectedGroups.length === 0) return showAlert("Nhắc nhở", "Vui lòng tích chọn nhóm P để tạo file in!", "warning");

    if (!currentShopDownloadDirPath) {
      return showAlert(
        "Cảnh báo chưa chọn thư mục",
        `Vui lòng chọn thư mục lưu PDF cho gian hàng [${currentShop?.name}] trước khi thực hiện in!`,
        "warning"
      );
    }

    showConfirm(
      "Xác nhận tạo file in",
      `Bạn có muốn tạo và in ${selectedGroups.length} nhóm P đã chọn?`,
      executePrintBatch
    );
  };

  const filteredGroups = currentGroups.filter((g) => {
    if (!searchFilter.trim()) return true;

    const filterKeywords = searchFilter
      .split(/[\s;]+/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);

    if (filterKeywords.length === 0) return true;

    const matchGroupName = filterKeywords.some((kw) => g.group_name?.toLowerCase().includes(kw));
    const matchMethod = filterKeywords.some((kw) => g.shipping_method?.toLowerCase().includes(kw));
    const matchOrders = g.orders?.some((o: any) =>
      filterKeywords.some((kw) => o.platform_order_id?.toLowerCase().includes(kw))
    );

    return matchGroupName || matchMethod || matchOrders;
  });

  const overallPercent =
    progressState.totalCount > 0 ? Math.round((progressState.completedCount / progressState.totalCount) * 100) : 0;

  if (loadingShops || isFetchShopsLoading) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center gap-3 bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
          Đang tải danh sách gian hàng...
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 bg-slate-100 h-screen text-slate-700 font-sans antialiased flex flex-col overflow-hidden">
      <div className="max-w-full mx-auto w-full flex-1 flex flex-col gap-3 overflow-hidden">

        {/* 1. THANH CẤU HÌNH GIAN HÀNG & BỘ LỌC TÌM KIẾM */}
        <div className="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col lg:flex-row justify-between items-center gap-4 flex-shrink-0">
          <div className="flex items-center gap-4 w-full lg:w-auto">
            {/* DROPDOWN CHỌN GIAN HÀNG */}
            <div className="flex flex-col gap-1 text-left min-w-[220px] max-w-xs relative">
              <span className="text-slate-400 font-bold text-[10px] uppercase tracking-wider flex items-center gap-1">
                <Store size={12} /> Gian hàng (Shop)
              </span>
              <button
                onClick={() => setIsShopDropdownOpen(!isShopDropdownOpen)}
                className="w-full h-9 border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs px-3 rounded-xl transition flex items-center justify-between gap-2 cursor-pointer focus:border-blue-500 shadow-2xs"
              >
                <span className="truncate">
                  {currentShop ? currentShop.name : "Chọn gian hàng..."}
                </span>
                <ChevronDown size={14} className="text-slate-400" />
              </button>

              {isShopDropdownOpen && (
                <div className="absolute left-0 top-[56px] w-full bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 text-left max-h-60 overflow-y-auto">
                  {availableShops.length > 0 ? (
                    availableShops.map((s) => {
                      const isSelected = s.id === selectedShopId;
                      return (
                        <div
                          key={s.id}
                          onClick={() => {
                            setSelectedShopId(s.id);
                            setIsShopDropdownOpen(false);
                          }}
                          className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-50 cursor-pointer select-none text-xs font-bold ${
                            isSelected ? "bg-blue-50/70 text-blue-600" : "text-slate-700"
                          }`}
                        >
                          <span className="truncate">{s.name}</span>
                          <span
                            className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded uppercase flex-shrink-0 ${
                              s.platform === "tiktok"
                                ? "bg-slate-900 text-white"
                                : "bg-orange-50 text-orange-600 border border-orange-200/50"
                            }`}
                          >
                            {s.platform === "tiktok" ? "TikTok" : "Shopee"}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="p-2 text-center text-xs text-slate-400">Chưa được gán shop nào</div>
                  )}
                </div>
              )}
            </div>

            {/* KIỂU COPY */}
            <div className="flex flex-col gap-1">
              <span className="text-slate-400 font-bold text-[10px] uppercase tracking-wider">
                Kiểu Copy
              </span>
              <div className="flex items-center gap-3 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/80 text-xs font-bold h-9">
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={copyOptions.space}
                    onChange={(e) => handleCopyOptionChange("space", e.target.checked)}
                    className="w-3.5 h-3.5 text-blue-600 rounded border-slate-300 focus:ring-0 cursor-pointer"
                  />
                  Space
                </label>
                <span className="text-slate-300">|</span>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={copyOptions.semicolon}
                    onChange={(e) => handleCopyOptionChange("semicolon", e.target.checked)}
                    className="w-3.5 h-3.5 text-blue-600 rounded border-slate-300 focus:ring-0 cursor-pointer"
                  />
                  Semicolon ( ; )
                </label>
              </div>
            </div>
          </div>

          {/* Ô TÌM KIẾM */}
          <div className="flex-1 w-full max-w-md relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400 pointer-events-none">
              <Search size={14} />
            </span>
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Tìm nhiều mã cùng lúc cách nhau bằng dấu cách hoặc dấu ;"
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-xl w-full text-xs font-semibold bg-slate-50 text-slate-700 outline-none focus:border-blue-500 focus:bg-white transition shadow-2xs h-9"
            />
          </div>
        </div>

        {/* 2. THANH CẤU HÌNH THƯ MỤC LƯU PDF */}
        <div className="bg-white px-4 py-2.5 rounded-2xl border border-slate-200/80 shadow-xs flex items-center justify-between gap-4 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 flex-shrink-0 border border-blue-100">
              <HardDrive size={16} />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-slate-400 font-extrabold text-[10px] uppercase tracking-wider">
                Thư mục lưu PDF cho [{currentShop?.name || "Gian hàng"}]
              </span>
              <span className="text-xs font-bold text-slate-800 truncate font-mono">
                {currentShopDownloadDirPath ? (
                  <span className="text-blue-600">📁 {currentShopDownloadDirPath}</span>
                ) : (
                  <span className="text-amber-600 italic">⚠️ Chưa cài đặt thư mục lưu cho gian hàng này</span>
                )}
              </span>
            </div>
          </div>

          <button
            onClick={handleSelectDownloadFolder}
            disabled={isSelectingFolder}
            className={`px-4 py-1.5 rounded-xl font-extrabold text-xs transition duration-150 flex items-center gap-1.5 flex-shrink-0 cursor-pointer shadow-2xs ${
              currentShopDownloadDirPath
                ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200/80"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {isSelectingFolder ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Đang chọn...
              </>
            ) : currentShopDownloadDirPath ? (
              <>
                <FolderCheck size={14} className="text-emerald-600" /> THAY ĐỔI THƯ MỤC
              </>
            ) : (
              <>
                <FolderOpen size={14} /> CHỌN THƯ MỤC LƯU
              </>
            )}
          </button>
        </div>

        {/* 3. HÀNG NÚT THAO TÁC NẰM TRÊN BẢNG */}
        <div className="flex justify-between items-center flex-shrink-0">
          <div className="text-xs font-bold text-slate-500 flex items-center gap-2">
            <span>Tổng số: <strong className="text-blue-600 font-mono">{filteredGroups.length}</strong> nhóm P</span>
            {selectedGroups.length > 0 && (
              <span className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded-lg text-[11px] font-extrabold border border-blue-100">
                Đã chọn: {selectedGroups.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsHistoryOpen(true)}
              className="px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-extrabold text-xs rounded-xl transition shadow-2xs cursor-pointer flex items-center gap-1.5"
            >
              <History size={14} className="text-blue-600" />
              LỊCH SỬ
            </button>

            <button
              onClick={handleClearAll}
              className="px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 text-slate-700 font-extrabold text-xs rounded-xl transition shadow-2xs cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw size={14} className="text-rose-500" />
              LÀM MỚI
            </button>

            <button
              onClick={() => setIsModalOpen(true)}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl shadow-xs transition cursor-pointer flex items-center gap-1.5"
            >
              <PlusCircle size={14} />
              NHẬP MÃ ĐƠN HÀNG
            </button>
          </div>
        </div>

        {/* 4. BẢNG LÀM VIỆC CHÍNH (GÁN REF ĐỂ AUTO SCROLL) */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 flex-1 flex flex-col overflow-hidden">
          <div ref={tableContainerRef} className="border border-slate-100 rounded-xl flex-1 overflow-auto shadow-inner mb-3">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50/90 backdrop-blur-xs z-10 shadow-2xs">
                <tr className="text-slate-400 font-bold border-b border-slate-100 tracking-wider">
                  <th className="p-3 w-12 text-center">
                    <input
                      type="checkbox"
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      checked={filteredGroups.length > 0 && selectedGroups.length === filteredGroups.length}
                      className="w-4 h-4 rounded text-blue-600 border-slate-300 focus:ring-0 cursor-pointer"
                    />
                  </th>
                  <th className="p-3 w-44">Nhóm P</th>
                  <th className="p-3">Đơn Vị Vận Chuyển</th>
                  <th className="p-3 w-28 text-center">Tổng Số Đơn</th>
                  <th className="p-3 w-36 text-center">Trạng Thái</th>
                  <th className="p-3 w-36 text-center">Thao Tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-600 font-semibold">
                {filteredGroups.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-16 text-center text-slate-400 font-medium">
                      {currentShop
                        ? `Gian hàng ${currentShop.name} chưa có nhóm đơn hàng nào. Hãy bấm Nhập mã đơn hàng.`
                        : "Vui lòng chọn gian hàng để bắt đầu."}
                    </td>
                  </tr>
                ) : (
                  filteredGroups.map((g) => {
                    const isExpanded = expandedGroups.includes(g.group_name);
                    const isCurrentlyActiveInProgress =
                      progressState.isOpen && progressState.currentGroup === g.group_name;

                    return (
                      <React.Fragment key={g.group_name}>
                        <tr
                          onClick={() => toggleExpandGroup(g.group_name)}
                          className={`hover:bg-slate-50 transition duration-150 font-bold border-b border-slate-100 cursor-pointer ${
                            isCurrentlyActiveInProgress ? "bg-blue-50/60" : "bg-white"
                          }`}
                        >
                          <td className="p-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedGroups.includes(g.group_name)}
                              onChange={() => {
                                setSelectedGroups((prev) =>
                                  prev.includes(g.group_name)
                                    ? prev.filter((x) => x !== g.group_name)
                                    : [...prev, g.group_name]
                                );
                              }}
                              className="w-4 h-4 rounded text-blue-600 border-slate-300 focus:ring-0 cursor-pointer"
                            />
                          </td>

                          <td className="p-2.5">
                            <span
                              className="text-blue-600 font-mono text-sm tracking-wide inline-flex items-center gap-1.5"
                              onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => startEditing(e, `group_name-${g.group_name}`, g.group_name)}
                            >
                              {isExpanded ? (
                                <ChevronDown size={14} className="text-slate-400" />
                              ) : (
                                <ChevronRight size={14} className="text-slate-400" />
                              )}

                              {editingId === `group_name-${g.group_name}` ? (
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={() => saveInlineEdit(g.group_name, "name")}
                                  onKeyDown={(e) => e.key === "Enter" && saveInlineEdit(g.group_name, "name")}
                                  className="border border-slate-300 px-1 py-0.5 rounded text-xs font-mono text-slate-800 w-24 focus:outline-none"
                                  autoFocus
                                />
                              ) : (
                                g.group_name
                              )}

                              {isCurrentlyActiveInProgress && loading && (
                                <span className="flex items-center text-[10px] text-blue-600 animate-pulse font-sans ml-1">
                                  <Loader2 size={12} className="animate-spin mr-1" /> Đang chạy...
                                </span>
                              )}
                            </span>
                          </td>

                          <td className="p-2.5">
                            <span
                              className="text-slate-600 font-semibold inline-block"
                              onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => startEditing(e, `method-${g.group_name}`, g.shipping_method)}
                            >
                              {editingId === `method-${g.group_name}` ? (
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={() => saveInlineEdit(g.group_name, "method")}
                                  onKeyDown={(e) => e.key === "Enter" && saveInlineEdit(g.group_name, "method")}
                                  className="border border-slate-300 px-1 py-0.5 rounded text-xs text-slate-800 w-48 focus:outline-none"
                                  autoFocus
                                />
                              ) : (
                                g.shipping_method
                              )}
                            </span>
                          </td>

                          <td className="p-2.5 text-center font-mono text-slate-900 bg-slate-50/50" onClick={(e) => e.stopPropagation()}>
                            {g.orders?.length || 0}
                          </td>

                          <td className="p-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <span
                              className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold tracking-wider border ${
                                g.status === "Đã in"
                                  ? "bg-purple-50 text-purple-600 border-purple-100/70"
                                  : g.status === "Đã xác nhận"
                                  ? "bg-emerald-50 text-emerald-600 border-emerald-100/70"
                                  : "bg-amber-50 text-amber-600 border-amber-100/70"
                              }`}
                            >
                              {g.status.toUpperCase()}
                            </span>
                          </td>

                          <td className="p-2 text-center flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={(e) => handleCopyOrderIds(e, g.group_name)}
                              className="p-1 hover:bg-blue-50 text-blue-600 rounded transition cursor-pointer flex items-center gap-1 text-[11px] font-extrabold px-2"
                              title="Copy danh sách đơn hàng"
                            >
                              <Copy size={13} /> COPY
                            </button>
                            <button
                              onClick={(e) => handleDeleteGroup(e, g.group_name)}
                              className="p-1 hover:bg-rose-50 text-rose-600 rounded transition cursor-pointer flex items-center gap-1 text-[11px] font-extrabold px-2"
                              title="Xóa nhóm P này"
                            >
                              <Trash2 size={13} /> XÓA
                            </button>
                          </td>
                        </tr>

                        {isExpanded &&
                          g.orders?.map((o: any) => (
                            <tr
                              key={o.platform_order_id}
                              className="text-[11px] font-medium text-slate-500 bg-slate-50/40 border-b border-slate-50 hover:bg-slate-100/50 transition duration-150 cursor-default"
                            >
                              <td></td>
                              <td colSpan={4} className="p-2 pl-9 select-text">
                                <span
                                  className="font-mono tracking-wider inline-block select-all cursor-pointer hover:text-slate-800"
                                  onDoubleClick={(e) =>
                                    startEditing(e, `order-${g.group_name}-${o.platform_order_id}`, o.platform_order_id)
                                  }
                                >
                                  {editingId === `order-${g.group_name}-${o.platform_order_id}` ? (
                                    <input
                                      type="text"
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      onBlur={() => saveInlineEdit(g.group_name, "order_id", o.platform_order_id)}
                                      onKeyDown={(e) =>
                                        e.key === "Enter" && saveInlineEdit(g.group_name, "order_id", o.platform_order_id)
                                      }
                                      className="border border-slate-300 px-1 py-0.5 rounded text-xs font-mono text-slate-800 w-48 focus:outline-none"
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  ) : (
                                    o.platform_order_id
                                  )}
                                </span>
                              </td>
                              <td className="p-1.5 text-center">
                                <button
                                  onClick={(e) => handleDeleteSingleOrder(e, g.group_name, o.platform_order_id)}
                                  className="text-slate-400 hover:text-red-600 text-sm font-black px-2 py-0.5 transition cursor-pointer"
                                  title="Xóa đơn hàng này"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-3 font-bold text-xs border-t border-slate-100 pt-3 flex-shrink-0">
            <button
              onClick={handleConfirmOrdersAPI}
              disabled={loading}
              className={`px-5 py-2.5 rounded-xl transition cursor-pointer ${
                loading && currentAction === "print"
                  ? "bg-slate-50 text-slate-300 border border-slate-100 cursor-not-allowed"
                  : "bg-slate-100 hover:bg-slate-200 text-slate-600"
              }`}
            >
              {loading && currentAction === "confirm" ? "⌛ ĐANG XỬ LÝ..." : confirmLabel}
            </button>
            <button
              onClick={handlePrintBatch}
              disabled={loading}
              className={`px-6 py-2.5 rounded-xl shadow-xs transition cursor-pointer ${
                loading && currentAction === "confirm"
                  ? "bg-purple-200 text-purple-300 cursor-not-allowed shadow-none"
                  : "bg-purple-600 hover:bg-purple-700 text-white"
              }`}
            >
              {loading && currentAction === "print" ? "⌛ ĐANG XỬ LÝ..." : printLabel}
            </button>
          </div>
        </div>

        {/* MODAL PROGRESS BAR */}
        {progressState.isOpen && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/60 backdrop-blur-xs transition duration-200">
            <div className="bg-white w-full max-w-lg rounded-2xl p-6 shadow-2xl border border-slate-100 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
                  {loading ? (
                    <Loader2 size={16} className="text-blue-600 animate-spin" />
                  ) : (
                    <CheckCircle2 size={16} className="text-emerald-600" />
                  )}
                  {progressState.title}
                </h3>
                <span className="font-mono text-xs font-extrabold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg">
                  {progressState.completedCount} / {progressState.totalCount} Nhóm
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs font-bold text-slate-600">
                  <span>Tiến trình:</span>
                  <span className="font-mono text-blue-600">{overallPercent}%</span>
                </div>
                <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden p-0.5 border border-slate-200/60">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-300 ease-out shadow-2xs"
                    style={{ width: `${overallPercent}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Trạng thái</span>
                {progressState.groupsProgress.map((item) => (
                  <div
                    key={item.groupName}
                    className={`flex items-center justify-between p-2.5 rounded-xl border text-xs font-bold transition ${
                      item.status === "processing"
                        ? "bg-blue-50/70 border-blue-200 text-blue-900"
                        : item.status === "success"
                        ? "bg-emerald-50/40 border-emerald-100 text-emerald-800"
                        : item.status === "error"
                        ? "bg-rose-50/40 border-rose-100 text-rose-800"
                        : "bg-slate-50/50 border-slate-100 text-slate-400"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-extrabold">{item.groupName}</span>
                      {item.message && <span className="text-[10px] font-normal italic">({item.message})</span>}
                    </div>

                    <div>
                      {item.status === "pending" && (
                        <span className="flex items-center gap-1 text-[11px] text-slate-400">
                          <Clock size={13} /> Chờ...
                        </span>
                      )}
                      {item.status === "processing" && (
                        <span className="flex items-center gap-1 text-[11px] text-blue-600 animate-pulse">
                          <Loader2 size={13} className="animate-spin" /> Đang xử lý...
                        </span>
                      )}
                      {item.status === "success" && (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-600 font-extrabold">
                          <CheckCircle2 size={13} /> Hoàn tất
                        </span>
                      )}
                      {item.status === "error" && (
                        <span className="flex items-center gap-1 text-[11px] text-rose-600 font-extrabold">
                          <XCircle size={13} /> Thất bại
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {!loading && (
                <div className="flex justify-end pt-3 border-t border-slate-100 mt-2">
                  <button
                    onClick={() => setProgressState((prev) => ({ ...prev, isOpen: false }))}
                    className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-2xs transition cursor-pointer"
                  >
                    XÁC NHẬN & ĐÓNG
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* MODAL NHẬP MÃ ĐƠN HÀNG */}
        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm transition duration-200">
            <div className="bg-white w-full max-w-2xl rounded-2xl shadow-xl border border-slate-100 p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-150">
              <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                <h3 className="text-base font-bold text-slate-900">
                  Nhập đơn hàng mới ({currentShop?.name || ""})
                </h3>
                <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 font-bold text-sm cursor-pointer">
                  ✕
                </button>
              </div>

              {/* Ô NHẬP SỐ P BẮT ĐẦU THÔNG MINH */}
              {(() => {
                const is3Cols = rawInput.trim().split("\n")[0]?.split(/[\t]+|\s{2,}/).length >= 3;
                return (
                  <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200/70">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold uppercase tracking-wide ${is3Cols ? "text-slate-300" : "text-slate-600"}`}>
                        Bắt đầu từ số P:
                      </span>
                      <input
                        type="number"
                        min="1"
                        disabled={is3Cols}
                        value={startPNumber}
                        onChange={(e) => setStartPNumber(e.target.value)}
                        placeholder={is3Cols ? "Tự lấy theo Cột 1" : "VD: 1"}
                        className={`px-3 py-1.5 border rounded-lg text-xs font-semibold focus:outline-none w-36 transition ${
                          is3Cols 
                            ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed" 
                            : "bg-white border-slate-200 text-slate-800 focus:border-slate-400"
                        }`}
                      />
                    </div>
                    <span className="text-[11px] font-medium text-slate-400 italic">
                      {is3Cols ? "Đã nhận 3 cột" : ""}
                    </span>
                  </div>
                );
              })()}

              <textarea
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                rows={8}
                className="w-full p-4 font-mono text-xs bg-slate-50/50 border border-slate-200 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500/5 focus:border-blue-500 focus:bg-white transition resize-none shadow-inner"
                placeholder="Nhập ĐVVC + Mã đơn hàng vào đây (hoặc 3 cột: Tên P + ĐVVC + Mã đơn)"
              />
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold text-xs rounded-xl transition cursor-pointer"
                >
                  HỦY BỎ
                </button>
                <button
                  onClick={handleMakeGroups}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-2xs transition cursor-pointer"
                >
                  CHIA NHÓM
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL LỊCH SỬ THAO TÁC */}
        {isHistoryOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm transition duration-200">
            <div className="bg-white w-full max-w-3xl rounded-2xl shadow-xl border border-slate-100 p-6 flex flex-col gap-4 max-h-[85vh]">
              <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  LỊCH SỬ XỬ LÝ - {currentShop?.name.toUpperCase()}
                </h3>
                <button onClick={() => setIsHistoryOpen(false)} className="text-slate-400 hover:text-slate-600 font-bold text-sm cursor-pointer">
                  ✕
                </button>
              </div>

              <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-4 text-xs">
                {currentHistory.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 font-semibold">Chưa có lịch sử xử lý</div>
                ) : (
                  currentHistory.map((item) => (
                    <div
                      key={item.id}
                      className="p-4 bg-white border border-slate-200 rounded-xl shadow-2xs flex flex-col gap-3 transition hover:border-slate-300"
                    >
                      <div className="flex justify-between items-center font-bold">
                        <div className="flex items-center gap-2 text-slate-800">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] text-white ${
                              item.action_type === "Xác nhận" ? "bg-emerald-600" : "bg-purple-600"
                            }`}
                          >
                            {item.action_type}
                          </span>
                          <span className="font-mono text-blue-600 text-sm">{item.group_name}</span>
                        </div>
                        <span className="text-slate-400 font-medium text-[11px]">{item.timestamp}</span>
                      </div>

                      <div className="grid grid-cols-3 bg-slate-50 p-2.5 rounded-xl border border-slate-100 text-center font-bold text-slate-600 text-[11px]">
                        <div>
                          Tổng đơn: <span className="text-slate-900 font-mono">{item.total_count}</span>
                        </div>
                        <div>
                          Thành công: <span className="text-emerald-600 font-mono">{item.success_count}</span>
                        </div>
                        <div>
                          Thất bại:{" "}
                          <span className={`${item.failed_count > 0 ? "text-rose-600" : "text-slate-400"} font-mono`}>
                            {item.failed_count}
                          </span>
                        </div>
                      </div>

                      {item.failed_details && item.failed_details.length > 0 && (
                        <div className="bg-rose-50/40 p-3 border border-rose-100 rounded-xl flex flex-col gap-2">
                          <div className="text-rose-700 font-extrabold text-[11px] uppercase tracking-wider">
                            CHI TIẾT ĐƠN THẤT BẠI:
                          </div>
                          <div className="max-h-36 overflow-y-auto flex flex-col gap-1 text-[11px] font-semibold text-slate-600 font-mono pl-1">
                            {item.failed_details.map((f, idx) => (
                              <div
                                key={idx}
                                className="flex justify-between items-center py-1 border-b border-rose-100/30 last:border-0 hover:bg-rose-50/60 px-1 rounded transition"
                              >
                                <span className="text-slate-800 tracking-wide select-all">{f.order_id}</span>
                                <span className="px-2 py-0.5 bg-white border border-rose-200 text-rose-600 rounded text-[10px] font-sans font-bold shadow-2xs">
                                  {f.reason}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="flex justify-end border-t border-slate-100 pt-3">
                <button
                  onClick={() => {
                    showConfirm(
                      "Xóa lịch sử",
                      `Xóa toàn bộ lịch sử thao tác của gian hàng ${currentShop?.name}?`,
                      () => {
                        if (selectedShopId) {
                          setHistoryMap((prev) => ({ ...prev, [selectedShopId]: [] }));
                          localStorage.removeItem(`ecom_history_${selectedShopId}`);
                        }
                      }
                    );
                  }}
                  disabled={currentHistory.length === 0}
                  className={`px-4 py-2 text-xs font-bold rounded-xl transition ${
                    currentHistory.length === 0
                      ? "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none"
                      : "bg-red-600 hover:bg-red-700 text-white cursor-pointer shadow-2xs"
                  }`}
                >
                  XÓA LỊCH SỬ
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL POP-UP CONFIRM THAO TÁC */}
        {confirmState.isOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/50 backdrop-blur-xs">
            <div className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl border border-slate-100 flex flex-col gap-4 text-center animate-in fade-in zoom-in-95 duration-150">
              <div className="w-12 h-12 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-100">
                <AlertTriangle size={24} />
              </div>
              <div className="flex flex-col gap-1">
                <h4 className="text-base font-extrabold text-slate-900">{confirmState.title}</h4>
                <p className="text-xs font-semibold text-slate-500 whitespace-pre-line leading-relaxed">
                  {confirmState.message}
                </p>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={() => setConfirmState((prev) => ({ ...prev, isOpen: false }))}
                  className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold transition cursor-pointer"
                >
                  HỦY BỎ
                </button>
                <button
                  onClick={() => {
                    const action = confirmState.onConfirm;
                    setConfirmState((prev) => ({ ...prev, isOpen: false }));
                    action();
                  }}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition cursor-pointer shadow-2xs"
                >
                  XÁC NHẬN
                </button>
              </div>
            </div>
          </div>
        )}

        {/* POP-UP ALERT THÔNG BÁO TÙY CHỈNH */}
        {alertState.isOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 backdrop-blur-xs">
            <div className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl border border-slate-100 flex flex-col gap-3 text-center animate-in fade-in zoom-in-95 duration-150">
              <div className="text-3xl">
                {alertState.type === "success" && "✅"}
                {alertState.type === "error" && "❌"}
                {alertState.type === "warning" && "⚠️"}
                {alertState.type === "info" && "ℹ️"}
              </div>
              <h4 className="text-base font-extrabold text-slate-900">{alertState.title}</h4>
              <p className="text-xs font-semibold text-slate-500 whitespace-pre-line leading-relaxed">{alertState.message}</p>
              <button
                onClick={() => setAlertState((prev) => ({ ...prev, isOpen: false }))}
                className={`mt-2 py-2 rounded-xl text-xs font-bold text-white transition duration-150 cursor-pointer shadow-2xs ${
                  alertState.type === "success"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : alertState.type === "error"
                    ? "bg-rose-600 hover:bg-rose-700"
                    : alertState.type === "warning"
                    ? "bg-amber-500 hover:bg-amber-600"
                    : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                XÁC NHẬN
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
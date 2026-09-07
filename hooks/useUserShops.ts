'use client';

import { useState, useEffect } from 'react';
import { createClient } from "@supabase/supabase-js";

// Khởi tạo Supabase Client riêng cho TikTok (Order E-com Manager)
const supabaseTiktok = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL_TIKTOK || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_TIKTOK || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

// Khởi tạo Supabase Client riêng cho Shopee (Order Processing)
const supabaseShopee = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL_SHOPEE || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY_SHOPEE || ""
);

export function useUserShops() {
  const [allowedShopIds, setAllowedShopIds] = useState<string[]>([]);
  const [loadingShops, setLoadingShops] = useState<boolean>(true);

  useEffect(() => {
    const fetchAllShops = async () => {
      setLoadingShops(true);
      try {
        // Truy vấn song song bảng shops ở cả 2 Database
        const [tiktokRes, shopeeRes] = await Promise.all([
          supabaseTiktok.from('shops').select('shop_id'),
          supabaseShopee.from('shops').select('shop_id'),
        ]);

        const tiktokIds = (tiktokRes.data || []).map((s: any) => s.shop_id);
        const shopeeIds = (shopeeRes.data || []).map((s: any) => s.shop_id);

        // Gộp tất cả shop_id của cả 2 sàn thành 1 danh sách không trùng lặp
        const allIds = Array.from(new Set([...tiktokIds, ...shopeeIds]));
        setAllowedShopIds(allIds);
      } catch (err) {
        console.error('Lỗi lấy danh sách shop:', err);
      } finally {
        setLoadingShops(false);
      }
    };

    fetchAllShops();
  }, []);

  return { allowedShopIds, loadingShops };
}
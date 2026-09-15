import type { NextConfig } from "next";

const isElectronBuild = process.env.ELECTRON_BUILD === "true";

const nextConfig: NextConfig = {
  // 🚀 Chỉ bật static export và prefix tương đối khi build cho Electron
  ...(isElectronBuild && {
    output: "export",
    assetPrefix: "./", 
  }),
  basePath: "",
  images: { 
    unoptimized: true 
  },
  // 🚀 Bắt buộc có trailingSlash để Next.js tạo cấu trúc folder/index.html chuẩn offline
  trailingSlash: true,
  // 🚀 Tắt SWC Minify strict nếu dính lỗi mã hóa JS trên macOS (tùy chọn an toàn)
  reactStrictMode: false,
};

export default nextConfig;
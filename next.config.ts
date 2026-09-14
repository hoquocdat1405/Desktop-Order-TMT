import type { NextConfig } from "next";

const isElectronBuild = process.env.ELECTRON_BUILD === "true";

const nextConfig: NextConfig = {
  ...(isElectronBuild && {
    output: "export",
    // 🚀 BẮT BUỘC: Đảm bảo các file CSS/JS build ra dùng đường dẫn tương đối ./ thay vì /
    assetPrefix: "./", 
  }),
  basePath: "",
  images: { 
    unoptimized: true 
  },
  // 🚀 Tự động thêm đuôi /index.html vào cuối thư mục để tránh lỗi 404 khi load đường dẫn
  trailingSlash: true,
};

export default nextConfig;
import type { NextConfig } from "next";

// Chỉ kích hoạt export static khi chạy lệnh build Electron local (npm run electron:build)
const isElectronBuild = process.env.ELECTRON_BUILD === "true";

const nextConfig: NextConfig = {
  ...(isElectronBuild && {
    output: "export",
  }),
  basePath: "",
  images: { 
    unoptimized: true 
  },
};

export default nextConfig;
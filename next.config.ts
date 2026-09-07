import type { NextConfig } from "next";

const isBuild = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Chỉ export static khi Build thật (dùng cho Electron)
  ...(isBuild && {
    output: "export",
  }),
  basePath: "",
  images: { 
    unoptimized: true 
  },
};

export default nextConfig;
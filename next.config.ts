import type { NextConfig } from "next";

const isBuild = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Chỉ export static khi Build thật, khi DEV thì bỏ đi để chạy Next Dev Server
  ...(isBuild && {
    output: "export",
    assetPrefix: "./",
  }),
  basePath: "",
  images: { unoptimized: true },
};

export default nextConfig;
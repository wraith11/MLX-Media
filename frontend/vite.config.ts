import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api and /sdapi to the local MLX backend so the
// frontend works out of the box when running `npm run dev`.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7861",
        changeOrigin: true,
      },
      "/sdapi": {
        target: "http://127.0.0.1:7861",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
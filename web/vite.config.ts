/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server (port 5183) proxies the backend (REST + WebSocket) on 127.0.0.1:8090.
// Ports are shifted from main (5173/8080) so both worktrees can run side by side.
// Production: server.mjs serves web/dist.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8090", ws: true, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});

// Temporary local config: dev server on 5183 proxying the 8092 WIA-demo backend. Not committed.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5183, strictPort: true, host: "127.0.0.1",
    proxy: { "/api": { target: "http://127.0.0.1:8092", ws: true, changeOrigin: false } },
  },
});

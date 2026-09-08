import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/target/**",
        "**/test-results/**",
        "**/benchmarks/generated/**",
      ],
    },
    proxy: { "/api": "http://127.0.0.1:1421" },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022" },
});

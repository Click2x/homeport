import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the interface runs on :5173 and forwards /api to a locally running Homeport server.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8484" } },
  build: { outDir: "dist", sourcemap: false },
});

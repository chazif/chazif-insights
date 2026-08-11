import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production build is served by FastAPI under /next/, so `base` must match
// (asset URLs in index.html become /next/assets/...). In dev, Vite proxies /api
// to the local FastAPI server so the React app and the backend share an origin.
export default defineConfig({
  plugins: [react()],
  base: "/next/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
});

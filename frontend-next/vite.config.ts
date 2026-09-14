import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production build is served by FastAPI at /, so `base` is "/"
// (asset URLs in index.html are /assets/...). In dev, Vite proxies /api
// to the local FastAPI server so the React app and the backend share an origin.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
});

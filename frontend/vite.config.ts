import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.VITE_BACKEND_URL ?? "http://localhost:7341";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7342,
    host: true,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/hub": { target: backend, changeOrigin: true, ws: true },
      "/ws": { target: backend, changeOrigin: true, ws: true },
    },
  },
});

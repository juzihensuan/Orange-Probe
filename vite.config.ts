import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4174", xfwd: true },
      "/ws": { target: "ws://localhost:4174", ws: true, xfwd: true },
      "/agent-ws": { target: "ws://localhost:4174", ws: true, xfwd: true },
    },
  },
});

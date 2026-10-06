import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The client is built to static files and served by the ARC server over HTTPS
// (one origin for the page and the persistent WebSocket).
export default defineConfig({
  root: fileURLToPath(new URL("./client", import.meta.url)),
  publicDir: fileURLToPath(new URL("./client/public", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("./client/dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});

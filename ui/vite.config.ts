import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const protocolSrc = fileURLToPath(new URL("../packages/protocol/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@code-lite/protocol": protocolSrc
    }
  },
  server: {
    port: 5173,
    strictPort: false
  },
  clearScreen: false
});

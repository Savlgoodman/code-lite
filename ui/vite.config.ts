import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const protocolSrc = fileURLToPath(new URL("../packages/protocol/src", import.meta.url));
const transportSrc = fileURLToPath(new URL("../packages/transport/src", import.meta.url));
const chatCoreSrc = fileURLToPath(new URL("../packages/chat-core/src", import.meta.url));
const syncSrc = fileURLToPath(new URL("../packages/sync/src", import.meta.url));
const chatRenderSrc = fileURLToPath(new URL("../packages/chat-render/src", import.meta.url));
const imageGenSrc = fileURLToPath(new URL("../packages/image-gen/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@code-lite/protocol": protocolSrc,
      "@code-lite/transport": transportSrc,
      "@code-lite/chat-core": chatCoreSrc,
      "@code-lite/sync": syncSrc,
      "@code-lite/chat-render": chatRenderSrc,
      "@code-lite/image-gen": imageGenSrc
    }
  },
  server: {
    port: 5173,
    strictPort: false
  },
  clearScreen: false
});

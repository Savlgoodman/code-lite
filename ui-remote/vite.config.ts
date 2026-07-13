import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createBuildInfo, type BuildInfo } from "../scripts/build-version.mjs";

const protocolSrc = fileURLToPath(new URL("../packages/protocol/src", import.meta.url));
const transportSrc = fileURLToPath(new URL("../packages/transport/src", import.meta.url));
const chatCoreSrc = fileURLToPath(new URL("../packages/chat-core/src", import.meta.url));
const syncSrc = fileURLToPath(new URL("../packages/sync/src", import.meta.url));
const chatRenderSrc = fileURLToPath(new URL("../packages/chat-render/src", import.meta.url));
const imageGenSrc = fileURLToPath(new URL("../packages/image-gen/src", import.meta.url));
const serviceWorkerBuildToken = "__CODE_LITE_BUILD_ID__";

function buildMetadataPlugin(buildInfo: BuildInfo): Plugin {
  let outputDir = "";

  return {
    name: "code-lite-build-metadata",
    apply: "build",
    configResolved(config) {
      outputDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const serviceWorkerPath = resolve(outputDir, "sw.js");
      const serviceWorker = await readFile(serviceWorkerPath, "utf8");
      if (!serviceWorker.includes(serviceWorkerBuildToken)) {
        throw new Error(`Service Worker build token not found: ${serviceWorkerBuildToken}`);
      }

      await Promise.all([
        writeFile(
          serviceWorkerPath,
          serviceWorker.replaceAll(serviceWorkerBuildToken, buildInfo.buildId),
          "utf8",
        ),
        writeFile(
          resolve(outputDir, "build-info.json"),
          `${JSON.stringify(buildInfo, null, 2)}\n`,
          "utf8",
        ),
      ]);
    },
  };
}

export default defineConfig(() => {
  const buildInfo = createBuildInfo();

  return {
    define: {
      __CODE_LITE_BUILD_INFO__: JSON.stringify(buildInfo),
    },
    plugins: [
      react(),
      buildMetadataPlugin(buildInfo),
    // Dev-only: 通用 AI API 代理，绕开浏览器 CORS。
    // 前端请求 /ai-proxy/{realUrl} → Vite 转发到 realUrl。
    {
      name: "ai-proxy",
      configureServer(server) {
        server.middlewares.use("/ai-proxy", async (req, res) => {
          // 从 URL 中取出真实目标地址：/ai-proxy/https://beeapi.ai/v1/models
          const targetUrl = req.url?.slice(1); // 去掉开头的 /
          if (!targetUrl || !targetUrl.startsWith("http")) {
            res.writeHead(400);
            res.end("Missing target URL");
            return;
          }
          try {
            // 透传请求头（去掉 host/origin 等浏览器专属头）
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
              const k = key.toLowerCase();
              if (k === "host" || k === "origin" || k === "referer" || k === "connection") continue;
              if (typeof value === "string") headers[key] = value;
            }

            // 收集请求体
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

            const resp = await fetch(targetUrl, {
              method: req.method ?? "GET",
              headers,
              body,
            });

            // fetch 已透明解压响应体，必须去掉 content-encoding / content-length，
            // 否则浏览器按 gzip 二次解压 → 响应体为空。
            const respHeaders: Record<string, string> = {};
            for (const [key, value] of resp.headers.entries()) {
              const k = key.toLowerCase();
              if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") continue;
              respHeaders[key] = value;
            }

            res.writeHead(resp.status, respHeaders);

            // 流式转发：逐块把上游响应体 pipe 到客户端，保留 SSE 实时性。
            if (resp.body) {
              const reader = resp.body.getReader();
              // 客户端断开时终止上游读取
              res.on("close", () => reader.cancel().catch(() => undefined));
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) res.write(Buffer.from(value));
              }
            }
            res.end();
          } catch (err: any) {
            res.writeHead(502);
            res.end(err?.message ?? "Proxy error");
          }
        });
      },
    },
    ],
    resolve: {
      alias: {
        "@code-lite/protocol": protocolSrc,
        "@code-lite/transport": transportSrc,
        "@code-lite/chat-core": chatCoreSrc,
        "@code-lite/sync": syncSrc,
        "@code-lite/chat-render": chatRenderSrc,
        "@code-lite/image-gen": imageGenSrc,
      },
    },
    server: {
      port: 5174,
      strictPort: false,
    },
    clearScreen: false,
  };
});

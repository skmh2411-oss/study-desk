import { defineConfig, loadEnv } from "vite";
import { buildCsp, normalizeSupabaseOrigin } from "./src/security";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig(({ command, mode }) => {
  const approved = normalizeSupabaseOrigin(
    loadEnv(mode, process.cwd(), "VITE_").VITE_SUPABASE_ORIGIN,
  );
  return {
    base: "./",
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes("node_modules")) {
              if (id.includes("katex")) return "math";
              if (id.includes("@supabase")) return "cloud";
              if (id.includes("ts-fsrs")) return "fsrs";
              if (/react-dom|react\/|scheduler/.test(id)) return "react";
              if (
                /remark|rehype|unified|unist|micromark|mdast|hast|markdown/.test(
                  id,
                )
              )
                return "markdown";
            }
          },
        },
      },
    },
    plugins: [
      {
        name: "study-security-policy",
        transformIndexHtml: {
          order: "post",
          handler(html: string) {
            const policy = buildCsp(approved, command === "serve").replaceAll(
              '"',
              "&quot;",
            );
            return html.replace(
              "<head>",
              `<head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`,
            );
          },
        },
      },
      react(),
      VitePWA({
        registerType: "prompt",
        includeAssets: ["icon-192.png", "icon-512.png", "apple-touch-icon.png"],
        manifest: {
          name: "Study Desk — 自分のための学習室",
          short_name: "Study Desk",
          lang: "ja",
          description: "記録と復習を、ひとつの場所に。",
          theme_color: "#172d45",
          background_color: "#f5f7fa",
          display: "standalone",
          start_url: "./",
          scope: "./",
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png" },
            {
              src: "icon-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "icon-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          globPatterns: [
            "**/*.{js,css,html,png,svg,woff2,wasm,gz,txt}",
            "ocr/assets.json",
            "ocr/licenses/*.json",
          ],
          navigateFallback: "index.html",
          maximumFileSizeToCacheInBytes: 4000000,
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    test: { environment: "node" },
  } as any;
});

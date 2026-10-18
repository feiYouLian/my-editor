import { defineConfig } from "vite";

// Tauri 推荐的 Vite 配置：固定端口、不清屏、构建目标 ES2022
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 忽略 cargo 构建目录：Windows 下 build script 的 exe 被占用会导致
      // watcher 抛 EBUSY 崩溃（node:internal/fs/watchers EBUSY -4082）
      ignored: ["**/src-tauri/target/**", "**/src-tauri/gen/**", "**/node_modules/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    // CM6 vendor chunk 约 900KB：本地桌面应用无网络开销，放宽警告线
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // CM6 核心生态单独分包：利于缓存，避免主 chunk 过大。
        // 注意：懒加载语言（@codemirror/lang-*）必须排除，否则会被并入
        // vendor chunk 导致失去按需加载能力（首屏全量拉取）。
        manualChunks(id) {
          if (id.includes("@codemirror/lang-")) return undefined;
          if (
            id.includes("@codemirror") ||
            id.includes("@lezer") ||
            id.includes("@marijn") ||
            id.includes("style-mod") ||
            id.includes("w3c-keyname")
          ) {
            return "codemirror";
          }
        },
      },
    },
  },
});

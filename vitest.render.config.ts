import { defineConfig } from "vitest/config";

// 面板渲染层测试：只验证「给定状态 → DOM 长什么样」。
// 与 vitest.config.ts 的零 DOM 单测分开跑：那套继续覆盖纯逻辑，这里补 UI 状态盲区。
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.render.test.ts"],
  },
});

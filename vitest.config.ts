import { defineConfig } from "vitest/config";

// 前端单测只覆盖「改坏了不明显」的纯逻辑（命令表数据、键位记法、消息缓冲）。
// 不引 jsdom：这些模块刻意做成零 DOM 依赖，引入 DOM 模拟器反而会让测试变慢、变脆。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

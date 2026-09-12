import { defineConfig } from "vitest/config";
// Opt-in tests that call real providers with keys from .env. Never part of npm test.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 180000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});

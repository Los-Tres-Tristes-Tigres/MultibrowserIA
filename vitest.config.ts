import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.browser.test.ts", "tests/**/*.live.test.ts"],
    testTimeout: 15000,
  },
});

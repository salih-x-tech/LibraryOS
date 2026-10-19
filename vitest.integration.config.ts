import { defineConfig } from "vitest/config";
import unitConfig from "./vitest.config.ts";

export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});

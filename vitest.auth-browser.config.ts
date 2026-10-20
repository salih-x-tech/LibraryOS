import { defineConfig } from "vitest/config";
import integrationConfig from "./vitest.integration.config.ts";

export default defineConfig({
  ...integrationConfig,
  test: {
    ...integrationConfig.test,
    include: ["tests/integration/auth/browser.test.ts"],
    exclude: [],
  },
});

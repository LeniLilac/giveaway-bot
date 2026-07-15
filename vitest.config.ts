import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
    environment: "node",
    coverage: { provider: "v8", reporter: ["text", "json", "html"] }
  }
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The SDK is injected by the bb app at runtime, so tests bind it to a
      // fake instead. Regex, not a bare "@" prefix: that would also swallow
      // every scoped package.
      {
        find: "@bb/plugin-sdk/app",
        replacement: `${root}test/sdk-fake.ts`,
      },
      { find: /^@\//, replacement: root },
    ],
  },
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});

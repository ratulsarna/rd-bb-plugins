import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@get-bb/plugin-sdk/app": `${root}test/sdk-fake.ts`,
    },
  },
  test: {
    include: ["test/app.test.tsx"],
    testTimeout: 15_000,
  },
});

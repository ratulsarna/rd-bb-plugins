import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@bb/plugin-sdk/app", replacement: `${root}test/sdk-fake.ts` },
      { find: "sonner", replacement: `${root}test/toast-fake.ts` },
      { find: /^@\//, replacement: root },
    ],
  },
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});

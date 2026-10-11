import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // inbox-core bundles its own react/react-dom; the postinstall script
    // points them at this plugin's copies so tests render one React.
    dedupe: ["react", "react-dom"],
    alias: [
      // The SDK is injected by the bb app at runtime, so tests bind it to a
      // fake instead. Regex, not a bare "@" prefix: that would also swallow
      // every scoped package.
      {
        find: /^@get-bb\/plugin-sdk\/app$/,
        replacement: `${root}test/sdk-fake.ts`,
      },
      { find: /^@\//, replacement: root },
    ],
  },
  // Core's files key collapse state on the bundling plugin's id, exactly as
  // bb's build does for this plugin; without it they fall back to "inbox:".
  define: {
    __BB_PLUGIN_ID__: JSON.stringify("inbox-sidebar"),
  },
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
    // Three jsdom files now start in parallel, and spinning up the DOM can
    // eat most of a 5s budget on a loaded machine.
    testTimeout: 15_000,
  },
});

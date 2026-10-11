import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // One React: inbox-core's dep tree resolves react from inbox-core's own
      // node_modules, but its CJS entries require react natively, which
      // aliases never see. The optimizer below bundles those deps and applies
      // these aliases inside them.
      {
        find: /^react-dom\/client$/,
        replacement: `${root}node_modules/react-dom/client`,
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: `${root}node_modules/react/jsx-runtime`,
      },
      {
        find: /^react-dom$/,
        replacement: `${root}node_modules/react-dom`,
      },
      {
        find: /^react$/,
        replacement: `${root}node_modules/react`,
      },
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
    deps: {
      optimizer: {
        // jsdom files run in the web environment; pre-bundle inbox-core's
        // React-using deps so their `require("react")` lands on the aliased,
        // plugin-owned copy instead of inbox-core's own.
        web: {
          enabled: true,
          include: [
            // Nested entries optimize inbox-core's own copies — the same
            // files core's imports resolve to, so the module runner's
            // rewrite matches and the chunks bind the aliased react.
            "inbox-core > @dnd-kit/core",
            "inbox-core > @dnd-kit/sortable",
            "inbox-core > @dnd-kit/utilities",
            "inbox-core > @radix-ui/react-dialog",
            "inbox-core > @radix-ui/react-context-menu",
            "inbox-core > @radix-ui/react-popover",
            "inbox-core > @hugeicons/react",
            "inbox-core > sonner",
          ],
        },
      },
    },
    // Three jsdom files now start in parallel, and spinning up the DOM can
    // eat most of a 5s budget on a loaded machine.
    testTimeout: 15_000,
  },
});

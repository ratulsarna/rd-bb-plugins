// bb bundles a dependency's imports from the dependency's own node_modules,
// and inbox-core's tree resolves react from there too — a second React copy
// next to the plugin's. The plugin's tests (and any vite-resolved module)
// need one React, so point inbox-core's react and react-dom at this
// plugin's. Idempotent; runs from the plugin's postinstall. The clone's own
// `npm ci` recreates the real packages, so the documented order (install in
// inbox-core, then here) always lands on the shared copies.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

let coreDir;
try {
  coreDir = path.dirname(require.resolve("inbox-core/package.json"));
} catch {
  // No sibling checkout — nothing to dedupe against.
  process.exit(0);
}

const pluginNodeModules = path.join(import.meta.dirname, "..", "node_modules");

for (const pkg of ["react", "react-dom"]) {
  const target = path.join(pluginNodeModules, pkg);
  const link = path.join(coreDir, "node_modules", pkg);
  if (!fs.existsSync(target)) continue;
  try {
    if (fs.readlinkSync(link) === target) continue;
  } catch {
    // Not a symlink: a real package from inbox-core's own npm ci.
  }
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, "dir");
  console.log(`dedupe-react: ${path.relative(process.cwd(), link)} -> ${path.relative(process.cwd(), target)}`);
}

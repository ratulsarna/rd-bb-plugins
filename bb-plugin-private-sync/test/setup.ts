import { createRequire } from "node:module";

// The public host SDK bundles CommonJS dependencies; BB supplies require at runtime.
Object.assign(globalThis, { require: createRequire(import.meta.url) });

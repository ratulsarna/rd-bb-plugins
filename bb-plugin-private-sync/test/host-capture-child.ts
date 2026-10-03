import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const root = process.env.CAPTURE_TEST_ROOT!;
const target = join(root, "doc.md");
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (from === target) {
    const editor = join(root, ".editor-save");
    await fs.writeFile(editor, "editor bytes captured before process death");
    await rename(editor, target);
  }
  await rename(from, to);
  if (from === target) {
    process.send!("captured");
    await new Promise(() => {});
  }
};
syncBuiltinESMExports();

const { HashCache, commitFile, writeChunk } = await import("../lib/host-fs");
const content = (bytes: string) => ({
  kind: "file" as const,
  hash: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  exec: false,
});
await fs.writeFile(target, "expected");
await writeChunk({
  root,
  path: "doc.md",
  tempId: "crashtest123",
  offset: 0,
  data: Buffer.from("incoming").toString("base64"),
});
await commitFile(new HashCache(join(root, "..", "cache.json")), {
  root,
  path: "doc.md",
  tempId: "crashtest123",
  content: content("incoming"),
  expected: content("expected"),
});
throw new Error("Capture interruption hook did not run");

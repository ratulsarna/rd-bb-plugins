import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedFiles = [
  "bb-plugin-sdk.d.ts",
  "bb-plugin-sdk-app.d.ts",
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} stopped with ${signal}`
            : `${command} exited with code ${code}`,
        ),
      );
    });
  });
}

const temporaryPlugin = await mkdtemp(join(tmpdir(), "bb-plugin-types-"));

try {
  await writeFile(
    join(temporaryPlugin, "package.json"),
    `${JSON.stringify(
      {
        name: "bb-plugin-sdk-types",
        version: "0.0.0",
        type: "module",
        bb: {
          name: "SDK Types",
          description: "Temporary package used to generate shared SDK types.",
          branding: { icon: "Code" },
          server: "./server.ts",
          app: "./app.tsx",
          skills: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(temporaryPlugin, "server.ts"), "export default function plugin() {}\n");
  await writeFile(join(temporaryPlugin, "app.tsx"), "export default {};\n");

  const bb = process.env.BB_CLI ?? (process.platform === "win32" ? "bb.cmd" : "bb");
  await run(bb, ["plugin", "types", temporaryPlugin]);

  const sharedTypes = join(repoRoot, "types");
  await mkdir(sharedTypes, { recursive: true });
  await Promise.all(
    generatedFiles.map((file) =>
      copyFile(join(temporaryPlugin, "types", file), join(sharedTypes, file)),
    ),
  );

  const entries = await readdir(repoRoot, { withFileTypes: true });
  const pluginDirectories = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("bb-plugin-"),
  );
  await Promise.all(
    pluginDirectories.flatMap((entry) =>
      generatedFiles.map((file) =>
        rm(join(repoRoot, entry.name, "types", file), { force: true }),
      ),
    ),
  );

  console.log("Updated shared BB SDK types in types/.");
} finally {
  await rm(temporaryPlugin, { recursive: true, force: true });
}

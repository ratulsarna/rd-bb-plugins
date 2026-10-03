import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server";
import { restartPrompt } from "../lib/restart-prompt";

type PromptInput = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["input"]>[number];

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inbox-machine-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const roots = { source: join(root, "srv", "assistants"), target: join(root, "mac", "assistants") };
  const vaults = { source: join(root, "srv", "vault"), target: join(root, "mac", "vault") };
  for (const hostId of ["source", "target"] as const) {
    await mkdir(join(roots[hostId], "sam", ".pi"), { recursive: true });
    await mkdir(vaults[hostId], { recursive: true });
    await writeFile(join(roots[hostId], "sam", ".pi", "SYSTEM.md"), "You are Sam.");
  }
  const status = {
    enabled: true, paused: false, configError: null as string | null,
    folders: [
      { id: "assistants", nodes: Object.entries(roots).map(([hostId, path]) => ({ hostId, path, ready: true, phase: "ready", error: null })) },
      { id: "vault", nodes: Object.entries(vaults).map(([hostId, path]) => ({ hostId, path, ready: true, phase: "ready", error: null })) },
    ],
  };
  const directory = [{ hostId: "source", name: "Server", connected: true }, { hostId: "target", name: "Mac", connected: true }, { hostId: "unmapped", name: "DGX", connected: true }];
  const project = { id: "fleet", name: "assistants", sources: Object.entries(roots).map(([hostId, path]) => ({ hostId, path })) };
  const thread = makeThreadResponse({ id: "old", title: "Sam", projectId: "fleet", providerId: "retired-provider", environmentId: "env-old" });
  const env = { id: "env-old", projectId: "fleet", hostId: "source", path: `${roots.source}/sam` };
  const { bb, harness } = createFakePluginHost({ pluginId: "inbox-sidebar" });
  disposals.push(() => harness.lifecycle.dispose());
  harness.sdk.stub("threads.get", async () => structuredClone(thread));
  harness.sdk.stub("environments.get", async () => structuredClone(env));
  harness.sdk.stub("projects.get", async () => structuredClone(project));
  harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "retired-model", permissionMode: "full", reasoningLevel: "high", serviceTier: "priority" }));
  harness.sdk.stub("providers.list", async () => [{ id: "codex", available: true }]);
  harness.sdk.stub("hosts.directory", async ({ hostId, path }) => {
    if (!directory.find((host) => host.hostId === hostId)?.connected) throw new Error("offline");
    const resolved = await realpath(path!);
    return { directory: resolved, parent: dirname(resolved), entries: [] };
  });
  harness.sdk.stub("files.read", async ({ hostId, path, rootPath }) => {
    if (!directory.find((host) => host.hostId === hostId)?.connected) throw new Error("offline");
    const resolved = await realpath(path);
    const boundary = await realpath(rootPath!);
    const inside = relative(boundary, resolved);
    if (inside.startsWith("../") || inside === "..") throw new Error("refused outside root");
    return { path, content: await readFile(resolved, "utf8"), contentEncoding: "utf8" };
  });
  const automations = [{ automation: { id: "heartbeat", name: "server heartbeat", execution: { mode: "agent", targetThreadId: "old" } } }];
  let barrierFailure = false;
  let afterBarrier: (() => void) | undefined;
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]) => {
    if (pluginId === "automations") return outputSchema.parse({ automations });
    if (pluginId !== "private-sync") throw new Error("unexpected plugin");
    let output: unknown;
    if (method === "status") output = status;
    else if (method === "machineDirectory") output = directory;
    else if (method === "sync") {
      if (barrierFailure) throw new Error("sync barrier refused");
      const folderId = (input as { folderId: string }).folderId;
      output = status.folders.find((folder) => folder.id === folderId);
      afterBarrier?.();
    } else throw new Error(`unexpected method ${method}`);
    return outputSchema.parse(output);
  });
  harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "new", projectId: "fleet" }));
  harness.sdk.stub("threads.archive", async () => ({}));
  plugin(bb);
  const request = {
    replaceThreadId: "old", title: "Sam", destinationHostId: "target", homePath: `${roots.target}/sam`, archiveSource: false,
    request: {
      projectId: "fleet", providerId: "codex", model: "dest-model", reasoningLevel: "high", permissionMode: "full",
      executionInputSources: { providerId: "explicit", model: "explicit" },
      environment: { type: "reuse", environmentId: "env-old" },
      input: [{ type: "text", text: "Hello" }] as PromptInput[],
      parentThreadId: "spoofed-parent", lifecycleOwnerThreadId: "spoofed-owner", sourceThreadId: "old",
    },
  };
  return { automations, root, roots, vaults, status, directory, project, thread, env, harness, request,
    failBarrier: () => { barrierFailure = true; }, afterBarrier: (action: () => void) => { afterBarrier = action; },
    create: () => harness.behavior.callRpc("createReplacementThread", request),
    calls: (path: string) => harness.inspection.sdk.callsTo(path),
  };
}

describe("assistant machine creation through the public SDK host", () => {
  it("uses the selected host/home and destination vault, keeping a fresh root and the source intact", async () => {
    const f = await fixture();
    const seeds = await f.harness.behavior.callRpc("assistantSeeds", { threadId: "old" }) as { identity: string; projectId: string; targetingAutomations: []; machines: Array<{ hostId: string }> };
    expect(seeds.machines.map((machine) => machine.hostId)).toEqual(["source", "target"]);
    const destination = await f.harness.behavior.callRpc("assistantDestination", { threadId: "old", hostId: "target" }) as { vaultPath: string; identity: string; providerAvailable: boolean };
    expect(destination.identity).toBe(seeds.identity);
    expect(destination.providerAvailable).toBe(false);
    const prompt = restartPrompt("old", { ...seeds, ...destination });
    expect(prompt).toContain(`${f.vaults.target}/Notes/`);
    expect(prompt).not.toContain(f.vaults.source);
    expect(await f.create()).toEqual({ newThreadId: "new", archivedSource: false });
    const [spawn] = f.calls("threads.spawn")[0] as [Record<string, unknown>];
    expect(spawn.environment).toEqual({ type: "host", hostId: "target", workspace: { type: "unmanaged", path: `${f.roots.target}/sam` } });
    expect(spawn).toMatchObject({ providerId: "codex", model: "dest-model", permissionMode: "full", origin: "plugin", originPluginId: "inbox-sidebar" });
    for (const key of ["parentThreadId", "sourceThreadId", "lifecycleOwnerThreadId"]) expect(spawn).not.toHaveProperty(key);
    expect(f.calls("threads.archive")).toEqual([]);
    const barriers = f.calls("plugins.callRpc").flatMap(([args]) => {
      const call = args as { method: string; input: unknown };
      return call.method === "sync" ? [call.input] : [];
    });
    expect(barriers).toEqual([
      { folderId: "assistants", hostIds: ["target"], timeoutMs: 30_000 },
      { folderId: "vault", hostIds: ["target"], timeoutMs: 30_000 },
    ]);
  });

  it("starts on a ready destination while the source machine is offline and its files are absent", async () => {
    const f = await fixture();
    f.directory[0].connected = false;
    await rm(`${f.roots.source}/sam`, { recursive: true });
    expect(await f.create()).toEqual({ newThreadId: "new", archivedSource: false });
    expect(f.calls("files.read").every(([args]) => (args as { hostId: string }).hostId === "target")).toBe(true);
    expect(f.calls("plugins.callRpc").filter(([args]) => (args as { method: string }).method === "sync").map(([args]) => (args as { input: { hostIds: string[] } }).input.hostIds)).toEqual([["target"], ["target"]]);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it.each([
    ["another host", (f: Awaited<ReturnType<typeof fixture>>) => { f.request.destinationHostId = "impostor"; }],
    ["unmapped host", (f: Awaited<ReturnType<typeof fixture>>) => { f.request.destinationHostId = "unmapped"; }],
    ["another project", (f: Awaited<ReturnType<typeof fixture>>) => { f.request.request.projectId = "other"; }],
    ["project source mismatch", (f: Awaited<ReturnType<typeof fixture>>) => { f.project.sources[1].path += "-spoof"; }],
    ["source identity mismatch", (f: Awaited<ReturnType<typeof fixture>>) => { f.env.path = `${f.roots.source}-spoof/sam`; }],
    ["another assistant", (f: Awaited<ReturnType<typeof fixture>>) => { f.request.homePath = `${f.roots.target}/forge`; }],
    ["root traversal", (f: Awaited<ReturnType<typeof fixture>>) => { f.request.homePath = `${f.roots.target}/../sam`; }],
    ["offline", (f: Awaited<ReturnType<typeof fixture>>) => { f.directory[1].connected = false; }],
    ["disabled sync", (f: Awaited<ReturnType<typeof fixture>>) => { f.status.enabled = false; }],
    ["paused sync", (f: Awaited<ReturnType<typeof fixture>>) => { f.status.paused = true; }],
    ["unready vault", (f: Awaited<ReturnType<typeof fixture>>) => { f.status.folders[1].nodes[1].ready = false; }],
    ["missing vault", (f: Awaited<ReturnType<typeof fixture>>) => { f.status.folders.pop(); }],
    ["invalid configuration", (f: Awaited<ReturnType<typeof fixture>>) => { f.status.configError = "invalid roots"; }],
    ["child source", (f: Awaited<ReturnType<typeof fixture>>) => { f.thread.parentThreadId = "parent"; }],
    ["archived source", (f: Awaited<ReturnType<typeof fixture>>) => { f.thread.archivedAt = 1; }],
    ["cross-host archive", (f: Awaited<ReturnType<typeof fixture>>) => { f.request.archiveSource = true; }],
    ["barrier failure", (f: Awaited<ReturnType<typeof fixture>>) => { f.failBarrier(); }],
  ])("refuses %s before spawn or archive", async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    await expect(f.create()).rejects.toThrow();
    expect(f.calls("threads.spawn")).toEqual([]);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it("refuses a missing identity file and an escaping home symlink", async () => {
    const f = await fixture();
    await rm(`${f.roots.target}/sam`, { recursive: true });
    await expect(f.create()).rejects.toThrow(/unavailable/);
    await symlink(`${f.roots.source}/sam`, `${f.roots.target}/sam`);
    await expect(f.create()).rejects.toThrow(/refused outside root/);
    expect(f.calls("threads.spawn")).toEqual([]);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it("refuses a target home that resolves to another assistant within the mapped root", async () => {
    const f = await fixture();
    await rm(`${f.roots.target}/sam`, { recursive: true });
    await mkdir(`${f.roots.target}/forge/.pi`, { recursive: true });
    await writeFile(`${f.roots.target}/forge/.pi/SYSTEM.md`, "You are Forge.");
    await symlink(`${f.roots.target}/forge`, `${f.roots.target}/sam`);
    await expect(f.create()).rejects.toThrow(/does not match the assistant identity/);
    expect(f.calls("threads.spawn")).toEqual([]);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it("rejects map changes during the fresh sync barrier", async () => {
    const f = await fixture();
    f.afterBarrier(() => { f.status.enabled = false; });
    await expect(f.create()).rejects.toThrow(/configuration changed/);
    expect(f.calls("threads.spawn")).toEqual([]);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it("refuses a source home identity changed during destination sync", async () => {
    const f = await fixture();
    f.afterBarrier(() => { f.env.path = `${f.roots.source}/forge`; });
    await expect(f.create()).rejects.toThrow(/configuration changed/);
    expect(f.calls("threads.spawn")).toEqual([]);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it("preserves the source when core rejects destination execution options", async () => {
    const f = await fixture();
    f.request.destinationHostId = "source";
    f.request.homePath = `${f.roots.source}/sam`;
    f.request.archiveSource = true;
    f.harness.sdk.stub("threads.spawn", async () => { throw new Error("model unavailable on destination"); });
    await expect(f.create()).rejects.toThrow(/model unavailable/);
    expect(f.calls("threads.archive")).toEqual([]);
  });

  it("allows a deliberate same-host replacement with disabled sync and archives only the selected thread", async () => {
    const f = await fixture();
    f.status.enabled = false;
    f.request.destinationHostId = "source";
    f.request.homePath = `${f.roots.source}/sam`;
    f.request.archiveSource = true;
    expect(await f.create()).toEqual({ newThreadId: "new", archivedSource: true });
    expect(f.calls("threads.archive")).toEqual([[{ threadId: "old" }]]);
    expect(f.calls("plugins.callRpc").some(([args]) => (args as { method: string }).method === "sync")).toBe(false);
    const operations = f.harness.inspection.sdk.calls.map((call) => call.path);
    expect(operations.indexOf("threads.spawn")).toBeLessThan(operations.indexOf("threads.archive"));
  });

  it("reports partial archive failure with the created id so the composer will not spawn twice", async () => {
    const f = await fixture();
    f.request.destinationHostId = "source";
    f.request.homePath = `${f.roots.source}/sam`;
    f.request.archiveSource = true;
    f.harness.sdk.stub("threads.archive", async () => { throw new Error("archive refused"); });
    expect(await f.create()).toMatchObject({ newThreadId: "new", archivedSource: false, archiveError: "Error: archive refused" });
    expect(f.calls("threads.spawn")).toHaveLength(1);
  });
});


it.each([true, false])("adds current validated automation policy without changing edited inputs, archiveSource=%s", async (archiveSource) => {
  const f = await fixture();
  await f.harness.behavior.callRpc("assistantSeeds", { threadId: "old" });
  f.automations[0].automation.name = "current server-only job";
  f.automations.push({ automation: { id: "unrelated", name: "Other conversation", execution: { mode: "agent", targetThreadId: "elsewhere" } } });
  f.request.destinationHostId = "source";
  f.request.homePath = `${f.roots.source}/sam`;
  f.request.archiveSource = archiveSource;
  f.request.request.providerId = "pi";
  f.request.request.model = "edited-model";
  const input: PromptInput[] = [
    { type: "text", text: "My edited message. Keep their targets on the existing conversation.", mentions: [] },
    { type: "localFile", path: "/synthetic/notes.txt", name: "notes.txt", mimeType: "text/plain" },
    { type: "image", url: "https://example.test/image.png" },
  ];
  f.request.request.input = input;
  expect(await f.create()).toEqual({ newThreadId: "new", archivedSource: archiveSource });
  const [spawn] = f.calls("threads.spawn")[0] as [{ input: PromptInput[]; executionInputSources: unknown }];
  expect(spawn).toMatchObject({ providerId: "pi", model: "edited-model", executionInputSources: f.request.request.executionInputSources });
  expect(spawn.input.slice(0, input.length)).toEqual(input);
  const guidance = spawn.input.at(-1) as { type: string; text: string };
  expect(guidance.type).toBe("text");
  expect(guidance.text).toContain("Use thread old as context");
  expect(guidance.text).toContain("supersedes any conflicting");
  expect(guidance.text).toContain("current server-only job (heartbeat)");
  expect(guidance.text).not.toContain("Other conversation");
  expect(guidance.text).toContain("including server-only jobs");
  expect(guidance.text).toContain("does not migrate automations");
  expect(guidance.text).toContain(archiveSource ? "Review automations targeting the source before repointing them" : "Keep automation targets on the source intact");
  expect(f.calls("threads.archive")).toHaveLength(archiveSource ? 1 : 0);
});

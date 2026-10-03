import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ASSISTANTS_PROJECT_NAME, homeSegmentUnder } from "./assistant-identity";

// Private Sync owns these mappings. Parse only the public fields we consume.
const nodeSchema = z.object({
  hostId: z.string(), path: z.string(), phase: z.string(),
  ready: z.boolean(), error: z.string().nullable(),
});
const folderSchema = z.object({ id: z.string(), nodes: z.array(nodeSchema) });
const statusSchema = z.object({
  enabled: z.boolean(), paused: z.boolean(), configError: z.string().nullable(),
  folders: z.array(folderSchema),
});
const machineDirectorySchema = z.array(z.object({
  hostId: z.string(), name: z.string(), connected: z.boolean(),
}));
export const assistantMachineSchema = z.object({
  hostId: z.string(), name: z.string(), connected: z.boolean(),
  assistantsRoot: z.string().nullable(), vaultPath: z.string().nullable(),
  ready: z.boolean(), reason: z.string().nullable(),
});
export const assistantDestinationSchema = z.object({
  hostId: z.string(), homePath: z.string(), identity: z.string(),
  vaultPath: z.string().nullable(),
  homes: z.array(z.object({ name: z.string(), path: z.string() })),
  ready: z.boolean(), reason: z.string().nullable(),
  providerAvailable: z.boolean(),
});
export type AssistantDestination = z.infer<typeof assistantDestinationSchema>;

function normalizedRoot(path: string): boolean {
  return path.startsWith("/") && path !== "/" &&
    !path.includes("\\") && !/[\u0000-\u001f]/.test(path) &&
    path.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..");
}

export async function assistantConversationContext(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId || thread.parentThreadId || thread.archivedAt != null)
    throw new Error("Choose an existing, unarchived root assistant conversation");
  const [env, project, status, directory] = await Promise.all([
    bb.sdk.environments.get({ environmentId: thread.environmentId }),
    bb.sdk.projects.get({ projectId: thread.projectId }),
    bb.sdk.plugins.callRpc({ pluginId: "private-sync", method: "status", input: null, outputSchema: statusSchema }),
    bb.sdk.plugins.callRpc({ pluginId: "private-sync", method: "machineDirectory", input: null, outputSchema: machineDirectorySchema }),
  ]);
  if (project.name.toLowerCase() !== ASSISTANTS_PROJECT_NAME || env.projectId !== thread.projectId)
    throw new Error("The conversation must belong to the assistants project");
  if (status.configError) throw new Error(`Private Sync configuration: ${status.configError}`);

  function node(folderId: string, hostId: string) {
    const folders = status.folders.filter((folder) => folder.id === folderId);
    const nodes = folders.flatMap((folder) => folder.nodes.filter((node) => node.hostId === hostId));
    if (folders.length !== 1 || nodes.length !== 1 || !normalizedRoot(nodes[0].path)) return null;
    return nodes[0];
  }
  function machine(hostId: string) {
    const hosts = directory.filter((host) => host.hostId === hostId);
    if (hosts.length !== 1) throw new Error("Destination machine is missing or ambiguous");
    const host = hosts[0];
    const assistants = node("assistants", hostId);
    const vault = node("vault", hostId);
    const sources = project.sources.filter((source) => source.hostId === hostId);
    const source = assistants && sources.length === 1 && sources[0].path === assistants.path;
    let reason: string | null = null;
    if (!host.connected) reason = "Machine is offline";
    else if (!assistants) reason = "No valid assistants root mapped in Private Sync";
    else if (!source) reason = "Project source does not match the mapped assistants root";
    else if (!vault) reason = "No valid vault root mapped in Private Sync";
    else if (!status.enabled && hostId !== env.hostId) reason = "Private Sync is disabled; enable it before starting on another machine";
    else if (status.enabled && status.paused) reason = "Private Sync is paused";
    else if (status.enabled) {
      const unready = [assistants, vault].find((node) => !node.ready || node.phase !== "ready");
      if (unready) reason = `Private Sync ${unready.phase}: ${unready.error ?? "destination files are not ready"}`;
    }
    return {
      ...host, assistantsRoot: assistants?.path ?? null, vaultPath: vault?.path ?? null,
      ready: reason === null, reason,
    };
  }
  const sourceRoot = node("assistants", env.hostId)?.path;
  const sourceCandidates = project.sources.filter((source) => source.hostId === env.hostId);
  const source = sourceRoot && sourceCandidates.length === 1 && sourceCandidates[0].path === sourceRoot ? sourceCandidates[0] : null;
  const segment = source && env.path && normalizedRoot(env.path) ? homeSegmentUnder(env.path, source.path) : null;
  if (!segment || segment === "." || segment === "..")
    throw new Error("Source home must be directly under its mapped project source");
  const identity = `${thread.projectId}:${segment}`;

  async function destination(hostId: string): Promise<AssistantDestination> {
    const target = machine(hostId);
    const homePath = target.assistantsRoot ? `${target.assistantsRoot}/${segment}` : "";
    const result: AssistantDestination = {
      hostId, homePath, identity, vaultPath: target.vaultPath,
      homes: homePath ? [{ name: segment!, path: homePath }] : [],
      ready: target.ready, reason: target.reason, providerAvailable: false,
    };
    if (!target.ready) return result;
    try {
      // rootPath makes the host reject assistant symlinks escaping the mapped root.
      await bb.sdk.files.read({ hostId, rootPath: target.assistantsRoot!, path: `${homePath}/.pi/SYSTEM.md` });
      const [root, home] = await Promise.all([
        bb.sdk.hosts.directory({ hostId, path: target.assistantsRoot! }),
        bb.sdk.hosts.directory({ hostId, path: homePath }),
        bb.sdk.hosts.directory({ hostId, path: target.vaultPath! }),
      ]);
      if (homeSegmentUnder(home.directory, root.directory) !== segment)
        throw new Error("Resolved destination home does not match the assistant identity");
      const providers = await bb.sdk.providers.list({ hostId });
      result.providerAvailable = providers.some((provider) => provider.id === thread.providerId && provider.available);
    } catch (error) {
      result.ready = false;
      result.reason = `Destination home or vault is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return result;
  }

  async function validate(hostId: string, homePath: string) {
    const target = await destination(hostId);
    if (!target.ready) throw new Error(target.reason ?? "Destination is not ready");
    if (homePath !== target.homePath) throw new Error("Destination home does not match the source assistant identity and mapped root");
    if (status.enabled) {
      const hostIds = [hostId];
      for (const folderId of ["assistants", "vault"]) {
        const synced = await bb.sdk.plugins.callRpc({
          pluginId: "private-sync", method: "sync", input: { folderId, hostIds, timeoutMs: 30_000 }, outputSchema: folderSchema,
        });
        if (synced.id !== folderId || hostIds.some((id) => !synced.nodes.some((node) => node.hostId === id && node.ready && node.phase === "ready" && node.path === (folderId === "assistants" ? machine(id).assistantsRoot : machine(id).vaultPath))))
          throw new Error(`Private Sync ${folderId} barrier did not confirm the mapped nodes`);
      }
      // A settings change during a barrier must not redirect a validated request.
      const refreshed = await assistantConversationContext(bb, threadId);
      if (!refreshed.status.enabled || refreshed.status.paused || refreshed.env.hostId !== env.hostId || refreshed.env.path !== env.path)
        throw new Error("Source or Private Sync configuration changed; select the destination again");
      const checked = await refreshed.destination(hostId);
      if (!checked.ready || checked.homePath !== homePath || checked.vaultPath !== target.vaultPath || checked.identity !== identity)
        throw new Error(checked.reason ?? "Destination mapping changed; select it again");
    }
    return target;
  }

  const machines = directory.map((host) => machine(host.hostId)).filter((host) => host.assistantsRoot !== null);
  return { thread, env, identity, segment, status, machines, destination, validate };
}

import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  STATUS_CHANGED,
  configInputSchema,
  foldersSchema,
  hostContract,
  hostSignals,
  rpcContract,
  type ConfigInput,
  type FolderConfig,
  type FolderStatus,
  type SyncStatus,
} from "./contract";
import { isWithin } from "./lib/paths";
import { Coordinator, type DesiredState } from "./lib/coordinator";
import { MIGRATIONS, Store } from "./lib/store";

export { rpcContract } from "./contract";
export type { SyncCoordinator } from "./lib/coordinator";

const PAUSED_KEY = "paused";

function parseFolders(raw: string): {
  folders: FolderConfig[];
  error: string | null;
} {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { folders: [], error: "The folders setting is not valid JSON" };
  }
  const parsed = foldersSchema.safeParse(json);
  if (!parsed.success)
    return {
      folders: [],
      error: parsed.error.issues[0]?.message ?? "Invalid folders setting",
    };
  return { folders: parsed.data, error: null };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Sync enabled",
      default: false,
    },
    folders: {
      type: "string",
      label: "Folders (JSON)",
      experimental_multiline: true,
      experimental_schema: z
        .string()
        .refine((value) => parseFolders(value).error === null, {
          message:
            "Folders must be a valid folder list; see the private-sync skill",
        }),
      default: "[]",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  const coordinator = new Coordinator({
    store,
    host,
    listHosts: async (signal) =>
      (await bb.sdk.hosts.list({ type: "persistent", signal })).map(
        ({ id, status }) => ({ id, status }),
      ),
    log: (message) => bb.log.warn(message),
    onStatusChange: () => bb.realtime.publish(STATUS_CHANGED, {}),
  });

  bb.agents.configure(({ host, environment }) => {
    const assistants = coordinator
      .getConfig()
      .find((folder) => folder.id === "assistants");
    const node = assistants?.nodes.find((node) => node.hostId === host.id);
    if (!node || !environment.path || !isWithin(environment.path, node.path))
      return { tools: [], skills: [] };
    const vault = coordinator
      .getConfig()
      .find((folder) => folder.id === "vault")
      ?.nodes.find((node) => node.hostId === host.id);
    return {
      tools: [],
      skills: [],
      instructions: `Current machine: ${JSON.stringify(host.name)} (${host.id}). Current working directory: ${JSON.stringify(environment.path)}. Assistants root: ${JSON.stringify(node.path)}. Personal vault: ${JSON.stringify(vault?.path ?? null)}. Use these current paths when earlier conversation messages refer to paths on another machine. Tools, credentials, terminals, and UI handles belong to the current machine; rediscover available tools on this machine.`,
    };
  });

  async function desiredState(): Promise<DesiredState> {
    const values = await settings.get();
    const { folders, error } = parseFolders(values.folders);
    const paused = (await bb.storage.kv.get<boolean>(PAUSED_KEY)) === true;
    return { enabled: values.enabled, paused, folders, configError: error };
  }

  let running = false;
  let applying = Promise.resolve();
  /**
   * The one owner of applying settings and pause state. Calls run in order, so
   * a caller's returned status includes its own change.
   */
  function refresh(): Promise<SyncStatus> {
    const applied = applying.then(async () => {
      if (running) coordinator.apply(await desiredState());
    });
    applying = applied.catch(() => {});
    return applied.then(() => coordinator.status());
  }
  settings.onChange(() => void refresh());

  host.experimental_onSignal("changed", ({ hostId, payload }) =>
    coordinator.onSignal(hostId, payload.folderId, payload.paths),
  );
  host.experimental_onWorkerExit(({ hostId }) =>
    coordinator.onWorkerExit(hostId),
  );

  bb.background.service("sync", {
    async start(signal) {
      running = true;
      await refresh();
      try {
        await coordinator.run(signal);
      } finally {
        running = false;
      }
    },
  });

  /** Validate against live hosts, fill the default primary, and store the result in settings. */
  async function configure(input: ConfigInput): Promise<SyncStatus> {
    const parsed = configInputSchema.parse(input);
    const hosts = new Map(
      (await bb.sdk.hosts.list()).map((entry) => [entry.id, entry]),
    );
    const serverHostId = (await bb.sdk.system.config()).primaryHostId;
    const folders: FolderConfig[] = parsed.folders.map((folder) => {
      for (const node of folder.nodes) {
        const known = hosts.get(node.hostId);
        if (!known)
          throw new Error(
            `Folder ${folder.id}: unknown machine ${node.hostId}`,
          );
        if (known.type !== "persistent")
          throw new Error(
            `Folder ${folder.id}: machine ${node.hostId} is not persistent`,
          );
      }
      const primaryHostId = folder.primaryHostId ?? serverHostId;
      if (
        !primaryHostId ||
        !folder.nodes.some((node) => node.hostId === primaryHostId)
      )
        throw new Error(
          `Folder ${folder.id}: set primaryHostId, or add a node on the server's own machine`,
        );
      return { ...folder, primaryHostId };
    });
    foldersSchema.parse(folders);
    await settings.experimental_set({
      folders: JSON.stringify(folders, null, 2),
      ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
    });
    return refresh();
  }

  async function setEnabled(enabled: boolean): Promise<SyncStatus> {
    if (enabled) {
      const saved = await settings.get();
      const parsed = parseFolders(saved.folders);
      if (parsed.error) throw new Error(parsed.error);
      return configure({ enabled: true, folders: parsed.folders });
    }
    await settings.experimental_set({ enabled: false });
    return refresh();
  }

  function resolveConflict(folderId: string, id: number): SyncStatus {
    store.resolveConflict(folderId, id, Date.now());
    coordinator.changed();
    return coordinator.status();
  }

  async function setPaused(paused: boolean): Promise<SyncStatus> {
    await bb.storage.kv.set(PAUSED_KEY, paused);
    return refresh();
  }

  bb.rpc.register(rpcContract, {
    machineDirectory: async () =>
      (await bb.sdk.hosts.list()).map((host) => ({
        hostId: host.id,
        name: host.name,
        connected: host.status === "connected",
      })),
    status: () => coordinator.status(),
    configure: (input) => configure(input),
    setEnabled: ({ enabled }) => setEnabled(enabled),
    resolveConflict: ({ folderId, id }) => resolveConflict(folderId, id),
    pause: () => setPaused(true),
    resume: () => setPaused(false),
    sync: ({ folderId, hostIds, timeoutMs }) =>
      coordinator.sync(folderId, hostIds, timeoutMs),
    resolvePath: ({ hostId, path }) => coordinator.resolvePath(hostId, path),
  });

  /** The machine the CLI runs on: the calling thread's host, else --host, else the server's own. */
  async function invokingHost(
    ctx: { threadId?: string },
    explicit: string | undefined,
  ): Promise<string | undefined> {
    if (explicit) return explicit;
    if (ctx.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId)
        return (
          await bb.sdk.environments.get({ environmentId: thread.environmentId })
        ).hostId;
    }
    return undefined;
  }

  function formatStatus(value: SyncStatus): string {
    const lines = [`enabled: ${value.enabled}  paused: ${value.paused}`];
    if (value.configError) lines.push(`config error: ${value.configError}`);
    for (const folder of value.folders) lines.push(...formatFolder(folder));
    if (value.folders.length === 0) lines.push("No folders configured.");
    return lines.join("\n");
  }
  function formatFolder(folder: FolderStatus): string[] {
    return [
      `${folder.id} (${folder.label})  version ${folder.headVersion}  open conflicts ${folder.openConflicts}`,
      ...folder.nodes.map(
        (node) =>
          `  ${node.hostId}${node.hostId === folder.primaryHostId ? " (primary)" : ""}  ${node.phase}  lag ${node.lag}` +
          (node.error ? `  error: ${node.error}` : ""),
      ),
      ...folder.conflicts
        .slice(0, 10)
        .map(
          (conflict) =>
            `  conflict ${conflict.id} ${conflict.kind}: ${conflict.conflictPath ?? conflict.path}`,
        ),
    ];
  }
  const output = (json: boolean, value: unknown, text: string) => ({
    exitCode: 0,
    stdout: json ? JSON.stringify(value) : text,
  });
  const fail = (error: unknown, code: string): never => {
    throw new PluginCliError(
      error instanceof Error ? error.message : String(error),
      { code },
    );
  };
  const jsonOption = {
    json: { type: "boolean", description: "Print machine-readable JSON" },
  } as const;

  bb.cli.register(
    defineCli({
      name: "private-sync",
      summary: "Real-time sync of private folders between your BB machines",
      commands: {
        status: cliCommand({
          summary:
            "Show folders, per-machine phase, lag, conflicts, and errors",
          options: jsonOption,
          async run({ options }) {
            const value = coordinator.status();
            return output(options.json, value, formatStatus(value));
          },
        }),
        configure: cliCommand({
          summary: "Replace the folder configuration from a private JSON file",
          options: {
            file: {
              type: "string",
              required: true,
              description:
                'JSON file {"enabled"?, "folders": [...]} on the machine running this command',
            },
            host: {
              type: "string",
              description:
                "Machine that holds the file when not run from a thread (default: the server's machine)",
            },
            ...jsonOption,
          },
          async run({ options }, ctx) {
            const hostId = await invokingHost(ctx, options.host);
            const file = await bb.sdk.files
              .read({ hostId, path: options.file })
              .catch((error) => fail(error, "file_unreadable"));
            const text =
              file.contentEncoding === "base64"
                ? Buffer.from(file.content, "base64").toString("utf8")
                : file.content;
            let input: unknown;
            try {
              input = JSON.parse(text);
            } catch {
              throw new PluginCliError("The file is not valid JSON", {
                code: "invalid_json",
              });
            }
            const parsed = configInputSchema.safeParse(input);
            if (!parsed.success)
              throw new PluginCliError(
                parsed.error.issues
                  .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                  .join("\n"),
                {
                  code: "invalid_config",
                },
              );
            const value = await configure(parsed.data).catch((error) =>
              fail(error, "invalid_config"),
            );
            return output(options.json, value, formatStatus(value));
          },
        }),
        enable: cliCommand({
          summary: "Validate the saved mapping and enable sync",
          options: jsonOption,
          async run({ options }) {
            const value = await setEnabled(true).catch((error) =>
              fail(error, "invalid_config"),
            );
            return output(options.json, value, formatStatus(value));
          },
        }),
        disable: cliCommand({
          summary: "Disable sync while retaining the saved mapping and pause state",
          options: jsonOption,
          async run({ options }) {
            const value = await setEnabled(false);
            return output(options.json, value, formatStatus(value));
          },
        }),
        resolve: cliCommand({
          summary: "Mark a conflict resolved without changing files",
          options: {
            folder: { type: "string", required: true, description: "Folder id" },
            id: { type: "string", required: true, description: "Conflict id from status" },
            ...jsonOption,
          },
          async run({ options }) {
            const input = rpcContract.resolveConflict.input.parse({
              folderId: options.folder,
              id: Number(options.id),
            });
            const value = resolveConflict(input.folderId, input.id);
            return output(options.json, value, formatStatus(value));
          },
        }),
        pause: cliCommand({
          summary: "Stop syncing every folder until resume",
          options: jsonOption,
          async run({ options }) {
            const value = await setPaused(true);
            return output(options.json, value, formatStatus(value));
          },
        }),
        resume: cliCommand({
          summary: "Resume syncing",
          options: jsonOption,
          async run({ options }) {
            const value = await setPaused(false);
            return output(options.json, value, formatStatus(value));
          },
        }),
        sync: cliCommand({
          summary:
            "Wait until machines finish a fresh full pass of a folder (a barrier)",
          options: {
            folder: {
              type: "string",
              required: true,
              description: "Folder id",
            },
            host: {
              type: "string",
              repeatable: true,
              description: "Machine id to wait for (repeatable; default all)",
            },
            timeout: {
              type: "duration",
              defaultUnit: "s",
              min: 1000,
              max: 30 * 60_000,
              default: 10 * 60_000,
              description: "How long to wait, up to 30m",
            },
            ...jsonOption,
          },
          async run({ options }) {
            const value = await coordinator
              .sync(options.folder, options.host, options.timeout)
              .catch((error) => fail(error, "sync_failed"));
            return output(options.json, value, formatFolder(value).join("\n"));
          },
        }),
      },
    }),
  );
}

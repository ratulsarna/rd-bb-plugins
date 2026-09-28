import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createCardStore, MIGRATIONS } from "../lib/store";
import { createWorktreeCleanup } from "../lib/worktree-cleanup";
import { makeCheckoutEnvironment } from "./sdk-fake";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });

const worktree = makeCheckoutEnvironment({ id: "env_lead", managed: true, isWorktree: true, workspaceProvisionType: "managed-worktree" });

function setup(threads: Record<string, Partial<ReturnType<typeof makeThreadResponse>>>, environments = [worktree]) {
  const archiveThreads = vi.fn(async (_input: { environmentId: string }) => ({ archivedThreadIds: [] }) as never);
  const host = createFakePluginHost({ pluginId: "pipeline", sdk: {
    threads: { get: (async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, ...threads[threadId] })) as never },
    environments: {
      get: (async ({ environmentId }: { environmentId: string }) => {
        const environment = environments.find((entry) => entry.id === environmentId);
        if (environment === undefined) throw new Error(`no environment ${environmentId}`);
        return environment;
      }) as never,
      archiveThreads: archiveThreads as never,
    },
  } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  const cleanup = createWorktreeCleanup(host.bb, store);
  const card = (id: string, leadThreadId: string | null, column: "reviewing" | "done" = "reviewing") => {
    store.create({ id, projectId: "proj_1", hostId: "host_mac", title: id, body: "", attachments: [], source: "cli" });
    return store.update(id, { leadThreadId, column });
  };
  return { host, store, cleanup, archiveThreads, card };
}

describe("worktree cleanup", () => {
  it("archives the lead worktree's threads once, when a card first reaches Done", async () => {
    const s = setup({ lead: { environmentId: "env_lead" } });
    s.card("card_1", "lead");
    s.store.update("card_1", { column: "done" });
    await vi.waitFor(() => expect(s.archiveThreads).toHaveBeenCalledExactlyOnceWith({ environmentId: "env_lead" }));
    await vi.waitFor(() => expect(s.store.history("card_1").at(-1)).toMatchObject({ kind: "worktree_retired", note: "env_lead" }));
    // Later edits to a finished card must not archive again.
    s.store.update("card_1", { body: "edited" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.archiveThreads).toHaveBeenCalledOnce();
  });

  it("never archives the shared project checkout, a missing lead, or an already archived lead", async () => {
    const s = setup({
      checkout: { environmentId: "env_checkout" },
      archived: { environmentId: "env_lead", archivedAt: 5 },
      gone: { environmentId: "env_lead", deletedAt: 5 },
    }, [worktree, makeCheckoutEnvironment()]);
    for (const [id, lead] of [["card_1", "checkout"], ["card_2", "archived"], ["card_3", "gone"], ["card_4", null]] as const) {
      s.card(id, lead, "done");
    }
    await s.cleanup.retireFinished();
    expect(s.archiveThreads).not.toHaveBeenCalled();
  });

  it("keeps going after one card fails and cleans the rest of the finished backlog", async () => {
    const s = setup({ broken: { environmentId: "env_missing" }, lead: { environmentId: "env_lead" } });
    s.card("card_1", "broken", "done");
    s.card("card_2", "lead", "done");
    s.archiveThreads.mockClear();
    await s.cleanup.retireFinished();
    expect(s.archiveThreads).toHaveBeenCalledWith({ environmentId: "env_lead" });
    expect(s.host.harness.inspection.logEntries.some((entry) => String(entry.message).includes("card_1"))).toBe(true);
  });
});

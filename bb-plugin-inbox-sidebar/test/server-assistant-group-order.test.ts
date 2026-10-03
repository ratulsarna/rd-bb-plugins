import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { assistantDisplayOrder, projectAssistantReorder } from "../lib/assistant-order";
import { projectPinnedReorder } from "../lib/pinned-order";

it("moves shared assistant groups up and down, writes unique order and preserves it on a fresh host", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "inbox-sidebar",
    sdk: {
      environments: { get: async ({ environmentId }) => ({
        id: environmentId, projectId: "fleet", hostId: "synthetic", path: `/synthetic/assistants/${environmentId.startsWith("sam") ? "sam" : "forge"}`,
      }) },
      projects: { get: async () => ({ sources: [{ hostId: "synthetic", path: "/synthetic/assistants" }] }) },
    },
  });
  plugin(bb);
  try {
    await vi.waitFor(() => expect(bb.storage.database().prepare("SELECT done FROM assistant_key_migration").get()).toEqual({ done: 1 }));
    const environmentIds = ["sam-server", "forge-server", "sam-mac", "forge-mac"];
    const resolved = await harness.behavior.callRpc("assistantIdentities", { environmentIds }) as { rows: Array<{ environmentId: string; identity: string }> };
    const rows = resolved.rows.map((row, index) => ({ id: row.environmentId, identity: row.identity, updatedAt: 100 - index }));
    const move = async (active: string, over: string, expected: string[]) => {
      const saved = await harness.behavior.callRpc("assistantOrder", {}) as { ids: string[] };
      const display = assistantDisplayOrder(rows, saved.ids);
      const projection = projectPinnedReorder(display.map((row) => row.id), active, over)!;
      const ids = projectAssistantReorder(display, active, projection.ids);
      expect(ids).toEqual(expected);
      expect(await harness.behavior.callRpc("setAssistantOrder", { identities: ids })).toEqual({ ids: expected });
    };
    await move("sam-mac", "forge-mac", ["fleet:forge", "fleet:sam"]);
    await move("sam-server", "forge-server", ["fleet:sam", "fleet:forge"]);
    await move("sam-server", "forge-server", ["fleet:forge", "fleet:sam"]);
    const restarted = await harness.lifecycle.reload(plugin);
    try {
      expect(await restarted.harness.behavior.callRpc("assistantOrder", {})).toEqual({ ids: ["fleet:forge", "fleet:sam"] });
      expect(restarted.bb.storage.database().prepare("SELECT * FROM assistant_order ORDER BY rank").all()).toEqual([
        { identity: "fleet:forge", rank: 0 }, { identity: "fleet:sam", rank: 1 },
      ]);
    } finally {
      await restarted.harness.lifecycle.dispose();
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});

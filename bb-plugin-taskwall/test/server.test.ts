import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { LEDGER_PATH, LEDGER_ROOT } from "../server.ts";
import type { TaskwallSnapshot } from "../lib/taskwall.ts";

test("the RPC reads the confined ledger path and returns grouped tasks", async (context) => {
  const reads: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "taskwall",
    sdk: {
      files: {
        read: async (args) => {
          reads.push(args);
          return {
            content: JSON.stringify([
              {
                id: "past",
                text: "Past task",
                dueDate: "2020-01-01",
                status: "open",
                createdAt: "2020-01-01T00:00:00Z",
                doneAt: null,
              },
            ]),
            contentEncoding: "utf8",
            mimeType: "application/json",
            sizeBytes: 1,
          };
        },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  plugin(host.bb);

  const result = await host.harness.behavior.callRpc("getWall", null) as TaskwallSnapshot;

  assert.deepEqual(reads, [{ path: LEDGER_PATH, rootPath: LEDGER_ROOT }]);
  assert.equal(result.overdue[0]?.id, "past");
  assert.equal(result.error, null);
});

test("an unreadable ledger returns an empty wall", async (context) => {
  const host = createFakePluginHost({
    pluginId: "taskwall",
    sdk: {
      files: {
        read: async () => {
          throw new Error("missing");
        },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  plugin(host.bb);

  const result = await host.harness.behavior.callRpc("getWall", null) as TaskwallSnapshot;

  assert.deepEqual(result.overdue, []);
  assert.deepEqual(result.today, []);
  assert.deepEqual(result.upcoming, []);
  assert.deepEqual(result.doneToday, []);
  assert.equal(result.error, "Ledger is unavailable.");
  assert.match(host.harness.logEntries[0]?.message ?? "", /ledger read failed/);
});
